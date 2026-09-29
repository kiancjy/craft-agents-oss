/**
 * Team API — the one request handler behind both ports.
 *
 * The caller resolves WHO is asking (team port: Cloudflare Access token;
 * owner port: the owner secret) and passes an Identity. Every route here
 * resolves the role for that identity on that page and asks roles.ts
 * `can()` before it reads or writes anything.
 */

import { existsSync } from 'node:fs'
import type { Identity } from './identity.ts'
import { type PageFiles, type PageInfo, isValidSlug } from './page-files.ts'
import {
  type EffectiveRole,
  type TeamAction,
  ROLE_LABELS,
  can,
  capabilities,
  isGeneralRule,
  isInDomain,
  isTeamRole,
  normalizeEmail,
  resolveRole,
} from './roles.ts'
import { type Actor, TeamStore, TeamStoreError, getTeamStorePath } from './store.ts'

export interface ApiOptions {
  files: PageFiles
  ownerEmail: string
  ownerName: string
  allowedDomain: string
  publicUrl: string | null
}

export type ApiErrorCode =
  | 'not-signed-in'
  | 'no-access'
  | 'forbidden'
  | 'page-not-found'
  | 'not-found'
  | 'invalid'
  | 'limit'
  | 'bad-request'

export const ERROR_MESSAGES = {
  noAccess: 'You do not have access to this page. Ask the owner for access.',
  pageDeleted: 'This page no longer exists.',
  notSignedIn: 'Sign in with your Incredible Google account.',
  ownerOnlyAction: 'Only the owner can run this action.',
  ownerCannotChange: 'The Owner cannot be changed from the team link.',
} as const

const STATUS: Record<ApiErrorCode, number> = {
  'not-signed-in': 401,
  'no-access': 403,
  forbidden: 403,
  'page-not-found': 404,
  'not-found': 404,
  invalid: 400,
  limit: 400,
  'bad-request': 400,
}

export function jsonError(code: ApiErrorCode, message: string): Response {
  return Response.json({ error: { code, message } }, { status: STATUS[code], headers: { 'cache-control': 'no-store' } })
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store' } })
}

const MAX_BODY_BYTES = 64 * 1024

async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  const length = Number(req.headers.get('content-length') ?? '0')
  if (length > MAX_BODY_BYTES) return null
  try {
    const text = await req.text()
    if (text.length > MAX_BODY_BYTES) return null
    const value = JSON.parse(text) as unknown
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
  } catch {
    return null
  }
}

interface PageContext {
  page: PageInfo
  role: EffectiveRole
  actor: Actor
  /** Opens the store lazily; creates it on first write only. */
  store: () => TeamStore
  hasStore: boolean
  close: () => void
}

export class TeamApi {
  constructor(private readonly options: ApiOptions) {}

  /** Role of one identity on one page, without creating a store. */
  roleFor(identity: Identity, page: PageInfo): EffectiveRole {
    const hasStore = existsSync(getTeamStorePath(page.folder))
    if (!hasStore) {
      return resolveRole({
        email: identity.email,
        ownerEmail: this.options.ownerEmail,
        allowedDomain: this.options.allowedDomain,
        personalRole: null,
        generalRule: 'none',
      })
    }
    const store = TeamStore.open(page.folder)
    try {
      return resolveRole({
        email: identity.email,
        ownerEmail: this.options.ownerEmail,
        allowedDomain: this.options.allowedDomain,
        personalRole: store.getPersonalRole(identity.email),
        generalRule: store.getGeneralRule(),
      })
    } finally {
      store.close()
    }
  }

  private pageContext(identity: Identity, slug: string): PageContext | Response {
    if (!isValidSlug(slug)) return jsonError('page-not-found', ERROR_MESSAGES.pageDeleted)
    const page = this.options.files.load(slug)
    if (!page) return jsonError('page-not-found', ERROR_MESSAGES.pageDeleted)
    const role = this.roleFor(identity, page)
    if (!can(role, 'read_page')) return jsonError('no-access', ERROR_MESSAGES.noAccess)
    let opened: TeamStore | null = null
    return {
      page,
      role,
      actor: { email: identity.email, name: role === 'owner' ? this.options.ownerName : identity.name },
      store: () => (opened ??= TeamStore.open(page.folder)),
      get hasStore() {
        return opened !== null || existsSync(getTeamStorePath(page.folder))
      },
      close: () => {
        opened?.close()
        opened = null
      },
    }
  }

  private require(ctx: PageContext, action: TeamAction): Response | null {
    return can(ctx.role, action) ? null : jsonError('forbidden', `Your role (${ROLE_LABELS[ctx.role]}) cannot do this.`)
  }

  teamLink(slug: string): string | null {
    return this.options.publicUrl ? `${this.options.publicUrl}/p/${slug}` : null
  }

  /** Route one /api request. `identity` is already verified by the caller. */
  async handle(req: Request, identity: Identity, url: URL): Promise<Response> {
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
    // parts[0] === 'api'
    const method = req.method.toUpperCase()

    if (parts.length === 2 && parts[1] === 'pages' && method === 'GET') {
      return this.listPages(identity)
    }
    if (parts[1] !== 'p' || parts.length < 4) return jsonError('not-found', 'Unknown route.')

    const slug = parts[2]!
    const ctxOrError = this.pageContext(identity, slug)
    if (ctxOrError instanceof Response) return ctxOrError
    const ctx = ctxOrError

    try {
      return await this.route(req, method, parts.slice(3), ctx, url)
    } catch (error) {
      if (error instanceof TeamStoreError) return jsonError(error.code, error.message)
      throw error
    } finally {
      ctx.close()
    }
  }

  private async route(req: Request, method: string, rest: string[], ctx: PageContext, url: URL): Promise<Response> {
    const [head, id, tail] = rest

    if (head === 'state' && method === 'GET' && rest.length === 1) return this.state(ctx)

    if (head === 'snapshot' && method === 'GET' && rest.length === 1) {
      const text = this.options.files.snapshotText(ctx.page.slug)
      return new Response(text ?? 'null', {
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      })
    }

    if (head === 'threads' && method === 'GET' && rest.length === 1) {
      const denied = this.require(ctx, 'read_threads')
      if (denied) return denied
      return json({ threads: ctx.hasStore ? ctx.store().listThreads() : [] })
    }

    if (head === 'threads' && method === 'POST' && rest.length === 1) {
      const denied = this.require(ctx, 'comment')
      if (denied) return denied
      const body = await readJson(req)
      if (!body) return jsonError('bad-request', 'Invalid request body.')
      return json({ thread: ctx.store().createThread(body.body, ctx.actor) }, 201)
    }

    if (head === 'threads' && id && tail === 'replies' && method === 'POST' && rest.length === 3) {
      const denied = this.require(ctx, 'comment')
      if (denied) return denied
      const body = await readJson(req)
      if (!body) return jsonError('bad-request', 'Invalid request body.')
      return json({ comment: ctx.store().addReply(id, body.body, ctx.actor) }, 201)
    }

    if (head === 'threads' && id && tail === 'resolve' && method === 'POST' && rest.length === 3) {
      const body = await readJson(req)
      if (!body || typeof body.resolved !== 'boolean') return jsonError('bad-request', 'Invalid request body.')
      const thread = ctx.hasStore ? ctx.store().getThread(id) : null
      if (!thread) return jsonError('not-found', 'This thread no longer exists.')
      const own = thread.createdBy === normalizeEmail(ctx.actor.email)
      const allowed = can(ctx.role, 'resolve_any_thread') || (own && can(ctx.role, 'resolve_own_thread'))
      if (!allowed) return jsonError('forbidden', `Your role (${ROLE_LABELS[ctx.role]}) cannot resolve this thread.`)
      return json({ thread: ctx.store().setResolved(id, body.resolved, ctx.actor) })
    }

    if (head === 'comments' && id && rest.length === 2 && (method === 'PATCH' || method === 'DELETE')) {
      const denied = this.require(ctx, 'edit_own_comment')
      if (denied) return denied
      if (!ctx.hasStore) return jsonError('not-found', 'This comment no longer exists.')
      if (method === 'DELETE') {
        ctx.store().deleteComment(id, ctx.actor)
        return json({ ok: true })
      }
      const body = await readJson(req)
      if (!body) return jsonError('bad-request', 'Invalid request body.')
      return json({ comment: ctx.store().editComment(id, body.body, ctx.actor) })
    }

    if (head === 'people' && rest.length === 1 && method === 'GET') {
      const denied = this.require(ctx, 'manage_people')
      if (denied) return denied
      return json(this.peopleView(ctx))
    }

    if (head === 'people' && rest.length === 1 && method === 'PUT') {
      const denied = this.require(ctx, 'manage_people')
      if (denied) return denied
      const body = await readJson(req)
      if (!body || typeof body.email !== 'string' || !isTeamRole(body.role)) {
        return jsonError('bad-request', 'Give an email and a role.')
      }
      const email = normalizeEmail(body.email)
      const invalid = this.checkPersonTarget(email)
      if (invalid) return invalid
      ctx.store().setPerson(email, body.role, ctx.actor)
      return json(this.peopleView(ctx))
    }

    if (head === 'people' && rest.length === 1 && method === 'DELETE') {
      const denied = this.require(ctx, 'manage_people')
      if (denied) return denied
      const email = normalizeEmail(url.searchParams.get('email') ?? '')
      if (email === normalizeEmail(this.options.ownerEmail)) {
        return jsonError('forbidden', ERROR_MESSAGES.ownerCannotChange)
      }
      if (ctx.hasStore) ctx.store().removePerson(email, ctx.actor)
      return json(this.peopleView(ctx))
    }

    if (head === 'general-rule' && rest.length === 1 && method === 'PUT') {
      const denied = this.require(ctx, 'manage_people')
      if (denied) return denied
      const body = await readJson(req)
      if (!body || !isGeneralRule(body.rule)) return jsonError('bad-request', 'The rule must be none, viewer, or commenter.')
      ctx.store().setGeneralRule(body.rule, ctx.actor)
      return json(this.peopleView(ctx))
    }

    if (head === 'changes' && rest.length === 1 && method === 'GET') {
      const denied = this.require(ctx, 'manage_people')
      if (denied) return denied
      return json({ changes: ctx.hasStore ? ctx.store().listChanges() : [] })
    }

    return jsonError('not-found', 'Unknown route.')
  }

  private checkPersonTarget(email: string): Response | null {
    if (email === normalizeEmail(this.options.ownerEmail)) {
      return jsonError('forbidden', ERROR_MESSAGES.ownerCannotChange)
    }
    if (!/^[^@\s]+@[^@\s]+$/.test(email) || !isInDomain(email, this.options.allowedDomain)) {
      return jsonError('invalid', `Only @${this.options.allowedDomain} accounts can be added.`)
    }
    return null
  }

  private peopleView(ctx: PageContext) {
    return {
      owner: { email: normalizeEmail(this.options.ownerEmail), name: this.options.ownerName },
      people: ctx.hasStore ? ctx.store().listPeople() : [],
      generalRule: ctx.hasStore ? ctx.store().getGeneralRule() : 'none',
      allowedDomain: this.options.allowedDomain,
    }
  }

  private state(ctx: PageContext): Response {
    const manage = can(ctx.role, 'manage_people')
    return json({
      page: {
        slug: ctx.page.slug,
        name: ctx.page.name,
        kind: ctx.page.kind,
        contentDigest: ctx.page.contentDigest ?? null,
        updatedAt: ctx.page.updatedAt,
      },
      me: {
        email: ctx.actor.email,
        name: ctx.actor.name,
        role: ctx.role,
        roleLabel: ROLE_LABELS[ctx.role],
        can: capabilities(ctx.role),
      },
      snapshotVersion: this.options.files.snapshotVersion(ctx.page.slug),
      threads: ctx.hasStore ? ctx.store().listThreads() : [],
      people: manage ? this.peopleView(ctx) : null,
      teamLink: this.teamLink(ctx.page.slug),
    })
  }

  private listPages(identity: Identity): Response {
    const pages = this.options.files
      .list()
      .map(page => {
        const role = this.roleFor(identity, page)
        return { page, role }
      })
      .filter(({ role }) => can(role, 'read_page'))
      .map(({ page, role }) => ({
        slug: page.slug,
        name: page.name,
        description: page.description ?? null,
        kind: page.kind,
        role,
        roleLabel: ROLE_LABELS[role],
      }))
    return json({ pages })
  }

  /**
   * Owner port only: team status of every page (open threads, people, rule).
   * Pages without a team store report zeros and create nothing.
   */
  summary(): Response {
    const pages: Record<string, { openThreads: number; people: number; generalRule: string; teamLink: string | null }> = {}
    for (const page of this.options.files.list()) {
      if (!existsSync(getTeamStorePath(page.folder))) {
        pages[page.slug] = { openThreads: 0, people: 0, generalRule: 'none', teamLink: this.teamLink(page.slug) }
        continue
      }
      const store = TeamStore.open(page.folder)
      try {
        pages[page.slug] = {
          openThreads: store.countOpenThreads(),
          people: store.listPeople().length,
          generalRule: store.getGeneralRule(),
          teamLink: this.teamLink(page.slug),
        }
      } finally {
        store.close()
      }
    }
    return json({ pages })
  }
}
