/**
 * Team server — two ports, one process.
 *
 *   Team port  (9200, local address): the Cloudflare tunnel connects here.
 *     Every request needs a valid Cloudflare Access token (identity.ts).
 *     Serves the team UI, the sandboxed page frame, and /api.
 *
 *   Owner port (9201, local address): the Craft Agents server and the agent
 *     connect here. Every request needs the owner secret from a mode-600
 *     file. Serves /api only, acting as the Owner.
 *
 * The tunnel delivers internet traffic from the local address, so a check on
 * the sender address cannot tell the Owner from a team member. Two ports can.
 *
 * This process never connects to the Craft Agents server and never loads
 * sources or credentials. It reads page files and writes only the team store.
 */

import { timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ERROR_MESSAGES, TeamApi, jsonError } from './api.ts'
import { type TeamServerConfig, ensureOwnerSecret, loadConfig } from './config.ts'
import { type Identity, TeamIdentityResolver, cameThroughCloudflare } from './identity.ts'
import { PageFiles, isValidSlug } from './page-files.ts'
import { can } from './roles.ts'
import { renderFrameResponse, renderMessagePage, renderShell } from './ui/html.ts'

export interface TeamServerAssets {
  appJs: string
  appCss: string
}

export async function buildAssets(): Promise<TeamServerAssets> {
  const uiDir = join(import.meta.dir, 'ui')
  const result = await Bun.build({
    entrypoints: [join(uiDir, 'app.ts')],
    target: 'browser',
    minify: true,
  })
  if (!result.success || !result.outputs[0]) {
    throw new Error(`UI build failed: ${result.logs.map(l => l.message).join('; ')}`)
  }
  return {
    appJs: await result.outputs[0].text(),
    appCss: readFileSync(join(uiDir, 'app.css'), 'utf-8'),
  }
}

const SHELL_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'content-security-policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  return ab.length === bb.length && timingSafeEqual(ab, bb)
}

/**
 * Cross-site request guard for the team port. The Access cookie travels with
 * any request to the host, so a write must carry a JSON content type and a
 * custom header (a cross-site form cannot set either without a preflight,
 * which this server never approves), and a present Origin must be this host.
 */
function isSafeWrite(req: Request, url: URL): boolean {
  const method = req.method.toUpperCase()
  if (method === 'GET' || method === 'HEAD') return true
  if (req.headers.get('x-pages-team') !== '1') return false
  if (method !== 'DELETE' && !req.headers.get('content-type')?.startsWith('application/json')) return false
  const origin = req.headers.get('origin')
  if (origin && origin !== url.origin) {
    const forwardedHost = req.headers.get('host')
    if (!forwardedHost || new URL(origin).host !== forwardedHost) return false
  }
  return true
}

export interface CreateHandlersOptions {
  config: TeamServerConfig
  ownerSecret: string
  assets: TeamServerAssets
  resolver?: TeamIdentityResolver
}

export function createHandlers(options: CreateHandlersOptions) {
  const { config, ownerSecret, assets } = options
  const files = new PageFiles(config.workspaceRoot)
  const api = new TeamApi({
    files,
    ownerEmail: config.ownerEmail,
    ownerName: config.ownerName,
    allowedDomain: config.allowedDomain,
    publicUrl: config.publicUrl,
  })
  const resolver =
    options.resolver ?? new TeamIdentityResolver({ access: config.access, devIdentity: config.devIdentity })

  function parseUrl(req: Request): URL | null {
    try {
      const url = new URL(req.url)
      decodeURIComponent(url.pathname)
      return url
    } catch {
      return null
    }
  }

  async function team(req: Request): Promise<Response> {
    const url = parseUrl(req)
    if (!url) return jsonError('bad-request', 'Invalid address.')
    const path = url.pathname

    if (path === '/healthz') return new Response('ok')
    // Assets hold no data, so the sign-in message page can use the style sheet.
    if (req.method === 'GET' && path === '/assets/app.js') {
      return new Response(assets.appJs, {
        headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' },
      })
    }
    if (req.method === 'GET' && path === '/assets/app.css') {
      return new Response(assets.appCss, {
        headers: { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' },
      })
    }

    const identity: Identity | null = await resolver.resolve(req)
    const isApi = path.startsWith('/api/')
    if (!identity) {
      return isApi
        ? jsonError('not-signed-in', ERROR_MESSAGES.notSignedIn)
        : renderMessagePage(401, 'Sign in required', ERROR_MESSAGES.notSignedIn)
    }
    if (!isSafeWrite(req, url)) return jsonError('bad-request', 'Request refused.')

    if (isApi) return api.handle(req, identity, url)

    if (req.method !== 'GET') return jsonError('not-found', 'Unknown route.')
    if (path === '/') return new Response(renderShell(), { headers: SHELL_HEADERS })

    const match = /^\/p\/([^/]+)(\/frame)?\/?$/.exec(path)
    if (match) {
      const slug = decodeURIComponent(match[1]!)
      if (!match[2]) return new Response(renderShell(), { headers: SHELL_HEADERS })
      const page = isValidSlug(slug) ? files.load(slug) : null
      if (!page) return renderMessagePage(404, 'Page not found', ERROR_MESSAGES.pageDeleted)
      if (!can(api.roleFor(identity, page), 'read_page')) {
        return renderMessagePage(403, 'No access', ERROR_MESSAGES.noAccess)
      }
      return renderFrameResponse(page.kind, files.content(slug) ?? '')
    }
    return renderMessagePage(404, 'Not found', 'This address does not exist.')
  }

  async function owner(req: Request): Promise<Response> {
    if (cameThroughCloudflare(req.headers)) return jsonError('not-signed-in', 'Refused.')
    const auth = req.headers.get('authorization') ?? ''
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
    if (!token || !safeEqual(token, ownerSecret)) return jsonError('not-signed-in', 'Owner secret required.')
    const url = parseUrl(req)
    if (!url) return jsonError('bad-request', 'Invalid address.')
    const identity: Identity = { email: config.ownerEmail, name: config.ownerName }

    if (url.pathname === '/api/info' && req.method === 'GET') {
      return Response.json({
        workspaceRoot: config.workspaceRoot,
        publicUrl: config.publicUrl,
        allowedDomain: config.allowedDomain,
        ownerEmail: config.ownerEmail,
        signIn: config.access ? 'cloudflare-access' : config.devIdentity ? 'test-identity' : 'none',
      })
    }
    if (url.pathname === '/api/summary' && req.method === 'GET') return api.summary()
    if (url.pathname.startsWith('/api/')) return api.handle(req, identity, url)
    return jsonError('not-found', 'Unknown route.')
  }

  return { team, owner, api }
}

function withErrors(handler: (req: Request) => Promise<Response>) {
  return async (req: Request): Promise<Response> => {
    try {
      return await handler(req)
    } catch (error) {
      console.error('[pages-team] request failed:', error)
      return Response.json({ error: { code: 'server', message: 'Server error.' } }, { status: 500 })
    }
  }
}

if (import.meta.main) {
  const config = loadConfig()
  const ownerSecret = ensureOwnerSecret(config.ownerSecretFile)
  const assets = await buildAssets()
  const handlers = createHandlers({ config, ownerSecret, assets })

  Bun.serve({ hostname: config.host, port: config.teamPort, fetch: withErrors(handlers.team) })
  Bun.serve({ hostname: config.host, port: config.ownerPort, fetch: withErrors(handlers.owner) })

  const signIn = config.access
    ? `Cloudflare Access (${config.access.teamDomain})`
    : config.devIdentity
      ? 'TEST IDENTITY (X-Dev-Email header). Local tests only.'
      : 'NONE: every team request is refused until Cloudflare Access is set up'
  console.log(`[pages-team] workspace ${config.workspaceRoot}`)
  console.log(`[pages-team] team port  http://${config.host}:${config.teamPort}  sign-in: ${signIn}`)
  console.log(`[pages-team] owner port http://${config.host}:${config.ownerPort}  secret: ${config.ownerSecretFile}`)
}
