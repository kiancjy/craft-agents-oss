/**
 * Team link UI — runs in the team member's browser.
 *
 * Plain DOM, no framework. All text from the server goes through
 * textContent, never innerHTML.
 *
 * The page itself runs in a sandboxed frame from /p/{slug}/frame. This
 * script is the bridge host for it, with the same `craft-pages/v1` protocol
 * as the app. It gives the page its data, and answers every source action
 * with "Only the owner can run this action." — the team link has no grants.
 *
 * Every 20 seconds (and on window focus) the UI fetches the state again.
 * That is how a removed role, a changed role, new comments, and a new page
 * version reach an open page in 1 minute or less.
 */

type Role = 'viewer' | 'commenter' | 'editor' | 'admin' | 'owner' | 'none'
type Action =
  | 'read_page'
  | 'read_threads'
  | 'comment'
  | 'edit_own_comment'
  | 'resolve_own_thread'
  | 'resolve_any_thread'
  | 'change_input'
  | 'manage_people'
  | 'run_source_action'
  | 'change_design'
  | 'change_owner'

interface Comment {
  id: string
  threadId: string
  authorEmail: string
  authorName: string
  body: string
  createdAt: number
  editedAt: number | null
  deleted: boolean
}
interface Thread {
  id: string
  createdBy: string
  createdByName: string
  createdAt: number
  resolvedAt: number | null
  resolvedBy: string | null
  comments: Comment[]
}
interface Person {
  email: string
  role: Exclude<Role, 'owner' | 'none'>
}
interface PeopleView {
  owner: { email: string; name: string }
  people: Person[]
  generalRule: 'none' | 'viewer' | 'commenter'
  allowedDomain: string
}
interface PageState {
  page: { slug: string; name: string; kind: 'static' | 'interactive' | 'live'; contentDigest: string | null }
  me: { email: string; name: string; role: Role; roleLabel: string; can: Record<Action, boolean> }
  snapshotVersion: string | null
  threads: Thread[]
  people: PeopleView | null
  teamLink: string | null
}

type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; code: string; message: string }

const PROTOCOL = 'craft-pages/v1'
const POLL_MS = 20_000

const TEXT = {
  noAccess: 'You do not have access to this page. Ask the owner for access.',
  deleted: 'This page no longer exists.',
  unavailable: 'This page is not available now. Try again later.',
  signedOut: 'Your sign-in has ended. Reload the page to sign in again.',
  ownerOnly: 'Only the owner can run this action.',
  ownerUseApp: 'Source actions run only in the Craft Agents app.',
  notSent: 'Not sent. Try again.',
  newVersion: 'A new version of this page is available.',
}

const ROLE_OPTIONS: Array<[Person['role'], string]> = [
  ['viewer', 'Viewer'],
  ['commenter', 'Commenter'],
  ['editor', 'Editor'],
  ['admin', 'Admin'],
]
const RULE_OPTIONS: Array<[PeopleView['generalRule'], string]> = [
  ['none', 'No access'],
  ['viewer', 'Viewer'],
  ['commenter', 'Commenter'],
]

// ----------------------------------------------------------------------------
// DOM helpers
// ----------------------------------------------------------------------------

type Child = Node | string | null | undefined | false
type Attrs = Record<string, string | boolean | ((e: Event) => void) | undefined>

function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue
    if (typeof value === 'function') el.addEventListener(key.replace(/^on/, '').toLowerCase(), value)
    else if (value === true) el.setAttribute(key, '')
    else el.setAttribute(key, value)
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue
    el.append(typeof child === 'string' ? document.createTextNode(child) : child)
  }
  return el
}

function formatTime(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}

async function api<T>(method: string, path: string, body?: unknown): Promise<ApiResult<T>> {
  let res: Response
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? { 'x-pages-team': '1' } : { 'x-pages-team': '1', 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    return { ok: false, status: 0, code: 'network', message: TEXT.unavailable }
  }
  let data: unknown = null
  try {
    data = await res.json()
  } catch {
    // A non-JSON answer comes from the gate or a proxy, not from this server.
    return { ok: false, status: res.status || 502, code: 'network', message: TEXT.unavailable }
  }
  if (!res.ok) {
    const err = (data as { error?: { code?: string; message?: string } })?.error
    return { ok: false, status: res.status, code: err?.code ?? 'server', message: err?.message ?? TEXT.unavailable }
  }
  return { ok: true, data: data as T }
}

function randomNonce(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
}

const app = document.getElementById('app')!

function showState(message: string, options: { reload?: boolean } = {}): void {
  app.replaceChildren(
    h(
      'div',
      { class: 'state', 'data-state': 'message' },
      h('p', { class: 'state-text' }, message),
      options.reload ? h('button', { class: 'btn', onclick: () => location.reload() }, 'Reload') : null,
    ),
  )
}

function messageForError(result: { status: number; code: string; message: string }): { text: string; reload: boolean } {
  if (result.code === 'no-access') return { text: TEXT.noAccess, reload: false }
  if (result.code === 'page-not-found') return { text: TEXT.deleted, reload: false }
  if (result.code === 'not-signed-in') return { text: TEXT.signedOut, reload: true }
  return { text: TEXT.unavailable, reload: true }
}

// ----------------------------------------------------------------------------
// Index: the pages shared with me
// ----------------------------------------------------------------------------

async function renderIndex(): Promise<void> {
  const result = await api<{ pages: Array<{ slug: string; name: string; description: string | null; roleLabel: string }> }>(
    'GET',
    '/api/pages',
  )
  if (!result.ok) {
    const m = messageForError(result)
    showState(m.text, { reload: m.reload })
    return
  }
  const list = result.data.pages
  app.replaceChildren(
    h(
      'div',
      { class: 'index' },
      h('h1', {}, 'Pages shared with you'),
      list.length === 0
        ? h('p', { class: 'muted' }, 'No pages are shared with you yet.')
        : h(
            'ul',
            { class: 'index-list' },
            ...list.map(p =>
              h(
                'li',
                {},
                h(
                  'a',
                  { href: `/p/${encodeURIComponent(p.slug)}`, class: 'index-card' },
                  h('span', { class: 'index-name' }, p.name),
                  p.description ? h('span', { class: 'muted' }, p.description) : null,
                  h('span', { class: 'pill' }, p.roleLabel),
                ),
              ),
            ),
          ),
    ),
  )
}

// ----------------------------------------------------------------------------
// Page view
// ----------------------------------------------------------------------------

class PageApp {
  private state: PageState | null = null
  private frame: HTMLIFrameElement | null = null
  private readonly nonce = randomNonce()
  private snapshot: unknown = null
  private panel: 'comments' | 'people' | null = window.innerWidth >= 900 ? 'comments' : null
  private showResolved = false
  private banners = new Map<string, HTMLElement>()
  /** Drafts survive a re-render of the thread list. Key: 'new' or a thread id. */
  private drafts = new Map<string, string>()
  private editing: string | null = null
  private failed = new Set<string>()
  private busy = new Set<string>()
  private pollTimer: number | null = null
  private dead = false

  private readonly headerRole = h('span', { class: 'pill', 'data-testid': 'role' })
  private readonly commentsButton = h('button', { class: 'btn btn-ghost', onclick: () => this.togglePanel('comments') })
  private readonly peopleButton = h('button', { class: 'btn btn-ghost', onclick: () => this.togglePanel('people') }, 'People')
  private readonly bannerArea = h('div', { class: 'banners' })
  private readonly panelEl = h('aside', { class: 'panel' })

  constructor(private readonly slug: string) {}

  private base(): string {
    return `/api/p/${encodeURIComponent(this.slug)}`
  }

  async start(): Promise<void> {
    const result = await api<PageState>('GET', `${this.base()}/state`)
    if (!result.ok) {
      const m = messageForError(result)
      showState(m.text, { reload: m.reload })
      return
    }
    this.state = result.data
    document.title = result.data.page.name
    if (result.data.snapshotVersion) await this.loadSnapshot()
    this.mount()
    window.addEventListener('message', e => this.onMessage(e))
    window.addEventListener('focus', () => void this.poll())
    this.schedulePoll()
  }

  private mount(): void {
    const s = this.state!
    const name = h('h1', { class: 'page-name' }, s.page.name)
    const header = h(
      'header',
      { class: 'bar' },
      h('a', { class: 'home', href: '/', title: 'All pages' }, 'Pages'),
      h('span', { class: 'sep' }, '/'),
      name,
      this.headerRole,
      h('span', { class: 'spacer' }),
      this.peopleButton,
      this.commentsButton,
    )
    this.frame = h('iframe', {
      class: 'frame',
      title: s.page.name,
      sandbox: s.page.kind === 'static' ? '' : 'allow-scripts allow-forms',
      referrerpolicy: 'no-referrer',
      src: `/p/${encodeURIComponent(this.slug)}/frame`,
    })
    this.frame.addEventListener('load', () => this.postInit())
    app.replaceChildren(header, this.bannerArea, h('div', { class: 'body' }, h('main', { class: 'main' }, this.frame), this.panelEl))
    this.renderChrome()
    this.renderPanel()
  }

  // ---------------------------------------------------------------- bridge

  private post(message: Record<string, unknown>): void {
    // '*' is required: the sandboxed frame has an opaque origin.
    this.frame?.contentWindow?.postMessage({ protocol: PROTOCOL, ...message }, '*')
  }

  private postInit(): void {
    const s = this.state
    if (!s) return
    this.post({
      type: 'init',
      payload: { page: { slug: s.page.slug, kind: s.page.kind }, nonce: this.nonce, snapshot: this.snapshot, grants: [] },
    })
  }

  private onMessage(event: MessageEvent): void {
    if (!this.frame || event.source !== this.frame.contentWindow || event.origin !== 'null') return
    const data = event.data as Record<string, unknown> | null
    if (!data || typeof data !== 'object' || data.protocol !== PROTOCOL || typeof data.type !== 'string') return
    switch (data.type) {
      case 'ready':
        this.postInit()
        break
      case 'grant-request':
        if (data.nonce !== this.nonce) return
        this.post({ type: 'grants', payload: { grants: [] } })
        this.ownerOnlyNotice()
        break
      case 'action':
        if (data.nonce !== this.nonce || typeof data.requestId !== 'string') return
        this.post({
          type: 'action-result',
          payload: { result: { requestId: data.requestId, ok: false, error: TEXT.ownerOnly, durationMs: 0 } },
        })
        this.ownerOnlyNotice()
        break
      case 'open-url': {
        if (data.nonce !== this.nonce || typeof data.url !== 'string') return
        try {
          const url = new URL(data.url)
          if (url.protocol === 'http:' || url.protocol === 'https:') window.open(url.href, '_blank', 'noopener,noreferrer')
        } catch {
          // ignore invalid addresses
        }
        break
      }
    }
  }

  private ownerOnlyNotice(): void {
    const text = this.state?.me.role === 'owner' ? `${TEXT.ownerOnly} ${TEXT.ownerUseApp}` : TEXT.ownerOnly
    this.setBanner('owner-only', text, 'info')
  }

  // ---------------------------------------------------------------- polling

  private schedulePoll(): void {
    if (this.pollTimer !== null) window.clearTimeout(this.pollTimer)
    this.pollTimer = window.setTimeout(() => void this.poll(), POLL_MS)
  }

  private async poll(): Promise<void> {
    if (this.dead) return
    const result = await api<PageState>('GET', `${this.base()}/state`)
    if (this.dead) return
    if (!result.ok) {
      if (result.code === 'no-access' || result.code === 'page-not-found') {
        this.dead = true
        this.frame = null
        const m = messageForError(result)
        showState(m.text)
        return
      }
      if (result.code === 'not-signed-in') this.setBanner('offline', TEXT.signedOut, 'warn', true)
      else this.setBanner('offline', TEXT.unavailable, 'warn')
      this.schedulePoll()
      return
    }
    this.setBanner('offline', null)
    const before = this.state!
    const next = result.data
    this.state = next

    if (before.me.role !== next.me.role) {
      this.setBanner('role', `Your role is now ${next.me.roleLabel}.`, 'info')
      if (!next.me.can.manage_people && this.panel === 'people') this.panel = 'comments'
    }
    if (before.page.contentDigest !== next.page.contentDigest) {
      this.setBanner('version', TEXT.newVersion, 'info', true)
    }
    if (next.snapshotVersion !== before.snapshotVersion && next.page.kind === 'live') {
      await this.loadSnapshot()
      this.post({ type: 'data', payload: { snapshot: this.snapshot } })
    }
    this.renderChrome()
    this.renderPanel()
    this.schedulePoll()
  }

  private async loadSnapshot(): Promise<void> {
    const result = await api<unknown>('GET', `${this.base()}/snapshot`)
    if (result.ok) this.snapshot = result.data
  }

  // ---------------------------------------------------------------- chrome

  private setBanner(key: string, text: string | null, tone: 'info' | 'warn' = 'info', reload = false): void {
    const existing = this.banners.get(key)
    if (text === null) {
      existing?.remove()
      this.banners.delete(key)
      return
    }
    const el = h(
      'div',
      { class: `banner banner-${tone}`, 'data-banner': key },
      h('span', {}, text),
      reload ? h('button', { class: 'btn btn-small', onclick: () => location.reload() }, 'Reload') : null,
      h('button', { class: 'btn btn-small btn-ghost', 'aria-label': 'Close', onclick: () => this.setBanner(key, null) }, '×'),
    )
    if (existing) existing.replaceWith(el)
    else this.bannerArea.append(el)
    this.banners.set(key, el)
  }

  private togglePanel(panel: 'comments' | 'people'): void {
    this.panel = this.panel === panel ? null : panel
    this.renderChrome()
    this.renderPanel()
  }

  private renderChrome(): void {
    const s = this.state!
    this.headerRole.textContent = s.me.roleLabel
    const open = s.threads.filter(t => t.resolvedAt === null).length
    this.commentsButton.textContent = open > 0 ? `Comments (${open})` : 'Comments'
    this.commentsButton.classList.toggle('active', this.panel === 'comments')
    this.peopleButton.hidden = !s.me.can.manage_people
    this.peopleButton.classList.toggle('active', this.panel === 'people')
    this.panelEl.hidden = this.panel === null
  }

  private renderPanel(): void {
    if (this.panel === null) {
      this.panelEl.replaceChildren()
      return
    }
    const focused = document.activeElement as HTMLElement | null
    const focusKey = focused?.dataset?.draft ?? null
    const content = this.panel === 'people' && this.state!.people ? this.renderPeople(this.state!.people) : this.renderComments()
    this.panelEl.replaceChildren(content)
    if (focusKey) {
      const target = this.panelEl.querySelector<HTMLTextAreaElement>(`[data-draft="${CSS.escape(focusKey)}"]`)
      if (target) {
        target.focus()
        target.setSelectionRange(target.value.length, target.value.length)
      }
    }
  }

  // ---------------------------------------------------------------- comments

  private composer(key: string, placeholder: string, label: string, send: (text: string) => Promise<boolean>): HTMLElement {
    const box = h('textarea', { class: 'input', rows: '2', placeholder, 'data-draft': key, maxlength: '5000' }) as HTMLTextAreaElement
    box.value = this.drafts.get(key) ?? ''
    box.addEventListener('input', () => {
      this.drafts.set(key, box.value)
      if (this.failed.delete(key)) this.renderPanel()
    })
    const submit = async () => {
      const text = box.value.trim()
      if (!text || this.busy.has(key)) return
      this.busy.add(key)
      this.renderPanel()
      const ok = await send(text)
      this.busy.delete(key)
      if (ok) {
        this.drafts.delete(key)
        this.failed.delete(key)
      } else {
        this.failed.add(key)
      }
      this.renderPanel()
    }
    box.addEventListener('keydown', e => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit()
    })
    return h(
      'div',
      { class: 'composer' },
      box,
      h(
        'div',
        { class: 'composer-row' },
        this.failed.has(key) ? h('span', { class: 'error', 'data-testid': 'not-sent' }, TEXT.notSent) : h('span', {}),
        h('button', { class: 'btn btn-primary btn-small', disabled: this.busy.has(key), onclick: () => void submit() }, label),
      ),
    )
  }

  private async mutate<T>(method: string, path: string, body?: unknown): Promise<ApiResult<T>> {
    const result = await api<T>(method, `${this.base()}${path}`, body)
    if (result.ok) await this.refreshState()
    else if (result.code === 'no-access' || result.code === 'page-not-found') await this.poll()
    else this.setBanner('action-error', result.message, 'warn')
    return result
  }

  private async refreshState(): Promise<void> {
    const result = await api<PageState>('GET', `${this.base()}/state`)
    if (result.ok) {
      this.state = result.data
      this.renderChrome()
    }
  }

  private renderComments(): HTMLElement {
    const s = this.state!
    const can = s.me.can
    const open = s.threads.filter(t => t.resolvedAt === null).reverse()
    const resolved = s.threads.filter(t => t.resolvedAt !== null).reverse()
    return h(
      'div',
      { class: 'panel-inner' },
      h('h2', {}, 'Comments'),
      can.comment
        ? this.composer('new', 'Add a comment', 'Comment', async text => (await this.mutate('POST', '/threads', { body: text })).ok)
        : h('p', { class: 'muted small' }, 'Your role can read comments. Ask an Admin for the Commenter role to write.'),
      open.length === 0 ? h('p', { class: 'muted small' }, 'No open comments.') : null,
      ...open.map(t => this.renderThread(t)),
      resolved.length > 0
        ? h(
            'button',
            {
              class: 'btn btn-ghost btn-small resolved-toggle',
              onclick: () => {
                this.showResolved = !this.showResolved
                this.renderPanel()
              },
            },
            `${this.showResolved ? 'Hide' : 'Show'} resolved (${resolved.length})`,
          )
        : null,
      ...(this.showResolved ? resolved.map(t => this.renderThread(t)) : []),
    )
  }

  private canResolve(t: Thread): boolean {
    const me = this.state!.me
    return me.can.resolve_any_thread || (me.can.resolve_own_thread && t.createdBy === me.email)
  }

  private renderThread(t: Thread): HTMLElement {
    const me = this.state!.me
    const isResolved = t.resolvedAt !== null
    return h(
      'section',
      { class: `thread${isResolved ? ' thread-resolved' : ''}`, 'data-thread': t.id },
      ...t.comments.map(c => this.renderComment(c)),
      isResolved ? h('p', { class: 'muted small' }, `Resolved ${formatTime(t.resolvedAt!)}`) : null,
      h(
        'div',
        { class: 'thread-actions' },
        this.canResolve(t)
          ? h(
              'button',
              { class: 'btn btn-ghost btn-small', onclick: () => void this.mutate('POST', `/threads/${t.id}/resolve`, { resolved: !isResolved }) },
              isResolved ? 'Reopen' : 'Resolve',
            )
          : null,
      ),
      !isResolved && me.can.comment
        ? this.composer(t.id, 'Reply', 'Reply', async text => (await this.mutate('POST', `/threads/${t.id}/replies`, { body: text })).ok)
        : null,
    )
  }

  private renderComment(c: Comment): HTMLElement {
    const me = this.state!.me
    const mine = c.authorEmail === me.email && me.can.edit_own_comment && !c.deleted
    const meta = h(
      'div',
      { class: 'comment-meta' },
      h('strong', {}, c.authorName),
      h('span', { class: 'muted small' }, formatTime(c.createdAt) + (c.editedAt ? ' (edited)' : '')),
    )
    if (c.deleted) {
      return h('div', { class: 'comment' }, meta, h('p', { class: 'muted small' }, 'Comment deleted.'))
    }
    if (this.editing === c.id) {
      const key = `edit:${c.id}`
      if (!this.drafts.has(key)) this.drafts.set(key, c.body)
      return h(
        'div',
        { class: 'comment' },
        meta,
        this.composer(key, 'Edit comment', 'Save', async text => {
          const ok = (await this.mutate('PATCH', `/comments/${c.id}`, { body: text })).ok
          if (ok) this.editing = null
          return ok
        }),
        h(
          'button',
          {
            class: 'btn btn-ghost btn-small',
            onclick: () => {
              this.editing = null
              this.drafts.delete(key)
              this.renderPanel()
            },
          },
          'Cancel',
        ),
      )
    }
    return h(
      'div',
      { class: 'comment' },
      meta,
      h('p', { class: 'comment-body' }, c.body),
      mine
        ? h(
            'div',
            { class: 'comment-actions' },
            h(
              'button',
              {
                class: 'link',
                onclick: () => {
                  this.editing = c.id
                  this.renderPanel()
                },
              },
              'Edit',
            ),
            h(
              'button',
              {
                class: 'link',
                onclick: () => {
                  if (confirm('Delete this comment?')) void this.mutate('DELETE', `/comments/${c.id}`)
                },
              },
              'Delete',
            ),
          )
        : null,
    )
  }

  // ---------------------------------------------------------------- people

  private renderPeople(view: PeopleView): HTMLElement {
    const me = this.state!.me
    const error = h('p', { class: 'error small', hidden: true })
    const showError = (message: string | null) => {
      error.textContent = message ?? ''
      error.hidden = message === null
    }
    const put = async (path: string, body: unknown, method = 'PUT') => {
      const result = await api<PeopleView>(method, `${this.base()}${path}`, body)
      if (!result.ok) {
        if (result.code === 'no-access' || result.code === 'page-not-found') return void this.poll()
        return showError(result.message)
      }
      await this.refreshState()
      this.renderPanel()
    }

    const select = <V extends string>(options: Array<[V, string]>, value: V, onChange: (v: V) => void) => {
      const el = h('select', { class: 'input input-select' }, ...options.map(([v, label]) => h('option', { value: v, selected: v === value }, label)))
      el.addEventListener('change', () => onChange(el.value as V))
      return el
    }

    const email = h('input', { class: 'input', type: 'email', placeholder: `name@${view.allowedDomain}`, 'data-testid': 'add-email' }) as HTMLInputElement
    let newRole: Person['role'] = 'viewer'
    const add = async () => {
      const value = email.value.trim()
      if (!value) return
      await put('/people', { email: value, role: newRole })
    }
    email.addEventListener('keydown', e => {
      if (e.key === 'Enter') void add()
    })

    const copy = this.state!.teamLink
      ? h(
          'button',
          {
            class: 'btn btn-small',
            onclick: async (e: Event) => {
              const btn = e.currentTarget as HTMLButtonElement
              await navigator.clipboard.writeText(this.state!.teamLink!)
              btn.textContent = 'Copied'
              setTimeout(() => (btn.textContent = 'Copy team link'), 1500)
            },
          },
          'Copy team link',
        )
      : null

    return h(
      'div',
      { class: 'panel-inner' },
      h('h2', {}, 'People'),
      h(
        'div',
        { class: 'field' },
        h('label', { class: 'small' }, 'Add a person'),
        h(
          'div',
          { class: 'row' },
          email,
          select(ROLE_OPTIONS, newRole, v => (newRole = v)),
          h('button', { class: 'btn btn-primary btn-small', onclick: () => void add() }, 'Add'),
        ),
      ),
      error,
      h(
        'div',
        { class: 'field' },
        h('label', { class: 'small' }, 'Everyone at Incredible'),
        select(RULE_OPTIONS, view.generalRule, v => void put('/general-rule', { rule: v })),
      ),
      h(
        'ul',
        { class: 'people' },
        h(
          'li',
          { class: 'person' },
          h('span', { class: 'person-email' }, view.owner.name, h('span', { class: 'muted small' }, ` ${view.owner.email}`)),
          h('span', { class: 'pill' }, 'Owner'),
        ),
        ...view.people.map(p =>
          h(
            'li',
            { class: 'person' },
            h('span', { class: 'person-email' }, p.email, p.email === me.email ? h('span', { class: 'muted small' }, ' (you)') : null),
            select(ROLE_OPTIONS, p.role, v => void put('/people', { email: p.email, role: v })),
            h(
              'button',
              {
                class: 'link',
                onclick: () => {
                  const self = p.email === me.email
                  if (confirm(self ? 'Remove yourself? You will lose access to this page.' : `Remove ${p.email}?`)) {
                    void put(`/people?email=${encodeURIComponent(p.email)}`, undefined, 'DELETE')
                  }
                },
              },
              'Remove',
            ),
          ),
        ),
      ),
      copy,
    )
  }
}

// ----------------------------------------------------------------------------
// Boot
// ----------------------------------------------------------------------------

const match = /^\/p\/([a-z0-9-]+)\/?$/.exec(location.pathname)
if (match) void new PageApp(match[1]!).start()
else void renderIndex()
