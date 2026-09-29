/**
 * End-to-end tests of both ports, through the real request handlers.
 * The team port uses the test identity (X-Dev-Email) unless a test says
 * otherwise; the sign-in check itself is covered in identity.test.ts.
 */

import { beforeEach, describe, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig } from '../src/config.ts'
import { TeamIdentityResolver } from '../src/identity.ts'
import { createHandlers } from '../src/server.ts'
import { DOMAIN, OWNER, makeWorkspace } from './helpers.ts'

const SECRET = 's'.repeat(43)
const assets = { appJs: '/* js */', appCss: '/* css */' }

function setup(options: { access?: boolean } = {}) {
  const root = makeWorkspace([
    { slug: 'demo', name: 'Demo page', snapshot: { kv: { a: 1 } } },
    { slug: 'static-doc', kind: 'static' },
  ])
  const config = loadConfig({
    PAGES_TEAM_WORKSPACE_ROOT: root,
    PAGES_TEAM_OWNER_EMAIL: OWNER,
    PAGES_TEAM_OWNER_NAME: 'Kian',
    PAGES_TEAM_PUBLIC_URL: 'https://pages.getincredible.com/',
    PAGES_TEAM_DEV_IDENTITY: options.access ? undefined : '1',
  })
  const resolver = options.access
    ? new TeamIdentityResolver({ access: { teamDomain: 't.cloudflareaccess.com', audience: 'aud' }, devIdentity: false, fetchImpl: async () => Response.json({ keys: [] }) })
    : undefined
  const handlers = createHandlers({ config, ownerSecret: SECRET, assets, resolver })

  const asTeam = (email: string | null, method: string, path: string, body?: unknown, extra: Record<string, string> = {}) =>
    handlers.team(
      new Request(`http://127.0.0.1:9200${path}`, {
        method,
        headers: {
          ...(email ? { 'x-dev-email': email } : {}),
          ...(method !== 'GET' ? { 'x-pages-team': '1' } : {}),
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...extra,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    )
  const asOwner = (method: string, path: string, body?: unknown, secret = SECRET) =>
    handlers.owner(
      new Request(`http://127.0.0.1:9201${path}`, {
        method,
        headers: {
          authorization: `Bearer ${secret}`,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    )
  return { root, handlers, asTeam, asOwner }
}

const YAS = `yas@${DOMAIN}`
const BEN = `ben@${DOMAIN}`

describe('team port: sign-in', () => {
  test('no sign-in proof: refused (API and HTML)', async () => {
    const { asTeam } = setup({ access: true })
    expect((await asTeam(null, 'GET', '/api/p/demo/state')).status).toBe(401)
    expect((await asTeam(null, 'GET', '/p/demo')).status).toBe(401)
  })

  test('false sign-in proof: refused', async () => {
    const { asTeam } = setup({ access: true })
    const res = await asTeam(null, 'GET', '/api/p/demo/state', undefined, { 'cf-access-jwt-assertion': 'aaa.bbb.ccc' })
    expect(res.status).toBe(401)
  })

  test('account outside the domain: no access, even with a role written into the store', async () => {
    const { asTeam, asOwner } = setup()
    // The owner port refuses to add it...
    const add = await asOwner('PUT', '/api/p/demo/people', { email: 'yas@gmail.com', role: 'admin' })
    expect(add.status).toBe(400)
    // ...and the general rule does not reach it either.
    await asOwner('PUT', '/api/p/demo/general-rule', { rule: 'commenter' })
    expect((await asTeam('yas@gmail.com', 'GET', '/api/p/demo/state')).status).toBe(403)
    expect((await asTeam('yas@gmail.com', 'GET', '/p/demo/frame')).status).toBe(403)
  })
})

describe('team port: roles', () => {
  let t: ReturnType<typeof setup>
  beforeEach(() => {
    t = setup()
  })

  test('signed in, no role: the no-access message', async () => {
    const res = await t.asTeam(YAS, 'GET', '/api/p/demo/state')
    expect(res.status).toBe(403)
    expect(((await res.json()) as any).error.message).toBe('You do not have access to this page. Ask the owner for access.')
  })

  test('viewer reads the page and threads, cannot comment', async () => {
    await t.asOwner('PUT', '/api/p/demo/people', { email: YAS, role: 'viewer' })
    const state = (await (await t.asTeam(YAS, 'GET', '/api/p/demo/state')).json()) as any
    expect(state.me.role).toBe('viewer')
    expect(state.people).toBeNull()
    expect(state.teamLink).toBe('https://pages.getincredible.com/p/demo')
    expect((await t.asTeam(YAS, 'GET', '/p/demo/frame')).status).toBe(200)
    expect((await t.asTeam(YAS, 'POST', '/api/p/demo/threads', { body: 'hi' })).status).toBe(403)
  })

  test('commenter comments, edits own, resolves own thread, not others', async () => {
    await t.asOwner('PUT', '/api/p/demo/people', { email: YAS, role: 'commenter' })
    const own = (await (await t.asTeam(YAS, 'POST', '/api/p/demo/threads', { body: 'Mine' })).json()) as any
    const other = (await (await t.asOwner('POST', '/api/p/demo/threads', { body: 'Owner thread' })).json()) as any
    expect((await t.asTeam(YAS, 'POST', `/api/p/demo/threads/${own.thread.id}/resolve`, { resolved: true })).status).toBe(200)
    expect((await t.asTeam(YAS, 'POST', `/api/p/demo/threads/${other.thread.id}/resolve`, { resolved: true })).status).toBe(403)
    const commentId = own.thread.comments[0].id
    expect((await t.asTeam(YAS, 'PATCH', `/api/p/demo/comments/${commentId}`, { body: 'Mine, edited' })).status).toBe(200)
    const ownerComment = other.thread.comments[0].id
    expect((await t.asTeam(YAS, 'PATCH', `/api/p/demo/comments/${ownerComment}`, { body: 'x' })).status).toBe(403)
    expect((await t.asTeam(YAS, 'GET', '/api/p/demo/people')).status).toBe(403)
  })

  test('editor resolves any thread, cannot manage people', async () => {
    await t.asOwner('PUT', '/api/p/demo/people', { email: YAS, role: 'editor' })
    const other = (await (await t.asOwner('POST', '/api/p/demo/threads', { body: 'Owner thread' })).json()) as any
    expect((await t.asTeam(YAS, 'POST', `/api/p/demo/threads/${other.thread.id}/resolve`, { resolved: true })).status).toBe(200)
    expect((await t.asTeam(YAS, 'PUT', '/api/p/demo/people', { email: BEN, role: 'viewer' })).status).toBe(403)
  })

  test('admin manages people and the general rule, and the record names the admin', async () => {
    await t.asOwner('PUT', '/api/p/demo/people', { email: YAS, role: 'admin' })
    expect((await t.asTeam(YAS, 'PUT', '/api/p/demo/people', { email: BEN, role: 'commenter' })).status).toBe(200)
    expect((await t.asTeam(YAS, 'PUT', '/api/p/demo/general-rule', { rule: 'viewer' })).status).toBe(200)
    const changes = (await (await t.asOwner('GET', '/api/p/demo/changes')).json()) as any
    expect(changes.changes[0]).toEqual(expect.objectContaining({ actorEmail: YAS, action: 'general_rule.set' }))
    expect(changes.changes[1]).toEqual(expect.objectContaining({ actorEmail: YAS, action: 'person.add' }))
    const state = (await (await t.asTeam(YAS, 'GET', '/api/p/demo/state')).json()) as any
    expect(state.people.people.map((p: any) => p.email)).toEqual([BEN, YAS])
  })

  test('admin cannot change or remove the Owner', async () => {
    await t.asOwner('PUT', '/api/p/demo/people', { email: YAS, role: 'admin' })
    expect((await t.asTeam(YAS, 'PUT', '/api/p/demo/people', { email: OWNER, role: 'viewer' })).status).toBe(403)
    expect((await t.asTeam(YAS, 'DELETE', `/api/p/demo/people?email=${encodeURIComponent(OWNER)}`)).status).toBe(403)
    // The Owner stays the Owner.
    const state = (await (await t.asTeam(OWNER, 'GET', '/api/p/demo/state')).json()) as any
    expect(state.me.role).toBe('owner')
  })

  test('general rule gives access to everyone at the domain; the higher role wins', async () => {
    await t.asOwner('PUT', '/api/p/demo/general-rule', { rule: 'commenter' })
    await t.asOwner('PUT', '/api/p/demo/people', { email: YAS, role: 'viewer' })
    const state = (await (await t.asTeam(YAS, 'GET', '/api/p/demo/state')).json()) as any
    expect(state.me.role).toBe('commenter')
  })

  test('role removed while the page is open: the next state fetch is no-access', async () => {
    await t.asOwner('PUT', '/api/p/demo/people', { email: YAS, role: 'commenter' })
    expect((await t.asTeam(YAS, 'GET', '/api/p/demo/state')).status).toBe(200)
    await t.asOwner('DELETE', `/api/p/demo/people?email=${encodeURIComponent(YAS)}`)
    expect((await t.asTeam(YAS, 'GET', '/api/p/demo/state')).status).toBe(403)
    expect((await t.asTeam(YAS, 'GET', '/p/demo/frame')).status).toBe(403)
  })

  test('page deleted: this page no longer exists', async () => {
    await t.asOwner('PUT', '/api/p/demo/people', { email: YAS, role: 'viewer' })
    rmSync(join(t.root, 'pages', 'demo'), { recursive: true })
    const res = await t.asTeam(YAS, 'GET', '/api/p/demo/state')
    expect(res.status).toBe(404)
    expect(((await res.json()) as any).error.message).toBe('This page no longer exists.')
  })

  test('the index lists only pages with a role', async () => {
    await t.asOwner('PUT', '/api/p/demo/people', { email: YAS, role: 'viewer' })
    const list = (await (await t.asTeam(YAS, 'GET', '/api/pages')).json()) as any
    expect(list.pages.map((p: any) => p.slug)).toEqual(['demo'])
  })
})

describe('team port: files and requests', () => {
  test('path test: only page files are served; other paths fail', async () => {
    const { asTeam, asOwner } = setup()
    await asOwner('PUT', '/api/p/demo/general-rule', { rule: 'viewer' })
    for (const path of [
      '/p/..%2F..%2Fetc%2Fpasswd/frame',
      '/p/%2e%2e/frame',
      '/p/demo%2F..%2F..%2Fsecret/frame',
      '/p/DEMO/frame',
      '/api/p/..%2Fdemo/state',
      '/api/p/demo%00/state',
      '/p/demo/page.json',
      '/p/demo/team/team.sqlite',
      '/pages/demo/index.html',
    ]) {
      const res = await asTeam(YAS, 'GET', path)
      expect([400, 403, 404]).toContain(res.status)
      const text = await res.text()
      expect(text).not.toContain('<h1>demo</h1>')
    }
  })

  test('the frame is served with a sandbox CSP and no network', async () => {
    const { asTeam, asOwner } = setup()
    await asOwner('PUT', '/api/p/demo/general-rule', { rule: 'viewer' })
    await asOwner('PUT', '/api/p/static-doc/general-rule', { rule: 'viewer' })
    const res = await asTeam(YAS, 'GET', '/p/demo/frame')
    const csp = res.headers.get('content-security-policy')!
    expect(csp).toContain('sandbox allow-scripts allow-forms')
    expect(csp).not.toContain('allow-same-origin')
    expect(csp).toContain("connect-src 'none'")
    expect(await res.text()).toBe('<h1>demo</h1>')
    const staticCsp = (await asTeam(YAS, 'GET', '/p/static-doc/frame')).headers.get('content-security-policy')!
    expect(staticCsp).toContain("script-src 'none'")
    expect(staticCsp).toMatch(/; sandbox$/)
  })

  test('writes without the team header or JSON type are refused (cross-site guard)', async () => {
    const { handlers, asOwner } = setup()
    await asOwner('PUT', '/api/p/demo/people', { email: YAS, role: 'commenter' })
    const form = await handlers.team(
      new Request('http://127.0.0.1:9200/api/p/demo/threads', {
        method: 'POST',
        headers: { 'x-dev-email': YAS, 'content-type': 'application/x-www-form-urlencoded' },
        body: 'body=hi',
      }),
    )
    expect(form.status).toBe(400)
    const crossOrigin = await handlers.team(
      new Request('http://127.0.0.1:9200/api/p/demo/threads', {
        method: 'POST',
        headers: { 'x-dev-email': YAS, 'x-pages-team': '1', 'content-type': 'application/json', origin: 'https://evil.example' },
        body: JSON.stringify({ body: 'hi' }),
      }),
    )
    expect(crossOrigin.status).toBe(400)
  })

  test('snapshot passes through for readers', async () => {
    const { asTeam, asOwner } = setup()
    await asOwner('PUT', '/api/p/demo/people', { email: YAS, role: 'viewer' })
    expect(await (await asTeam(YAS, 'GET', '/api/p/demo/snapshot')).json()).toEqual({ kv: { a: 1 } })
  })

  test('pages without team settings get no team folder from reads', async () => {
    const { root, asTeam, asOwner } = setup()
    await asTeam(YAS, 'GET', '/api/p/static-doc/state')
    await asOwner('GET', '/api/summary')
    const { existsSync } = await import('node:fs')
    expect(existsSync(join(root, 'pages', 'static-doc', 'team'))).toBe(false)
  })
})

describe('owner port', () => {
  test('refuses a missing or wrong secret', async () => {
    const { asOwner } = setup()
    expect((await asOwner('GET', '/api/info', undefined, 'wrong')).status).toBe(401)
    expect((await asOwner('GET', '/api/info', undefined, '')).status).toBe(401)
  })

  test('refuses requests that came through Cloudflare, even with the secret', async () => {
    const { handlers } = setup()
    const res = await handlers.owner(
      new Request('http://127.0.0.1:9201/api/info', { headers: { authorization: `Bearer ${SECRET}`, 'cf-ray': 'x' } }),
    )
    expect(res.status).toBe(401)
  })

  test('acts as the Owner and reports a summary', async () => {
    const { asOwner } = setup()
    await asOwner('POST', '/api/p/demo/threads', { body: 'One' })
    const two = (await (await asOwner('POST', '/api/p/demo/threads', { body: 'Two' })).json()) as any
    await asOwner('POST', `/api/p/demo/threads/${two.thread.id}/resolve`, { resolved: true })
    const summary = (await (await asOwner('GET', '/api/summary')).json()) as any
    expect(summary.pages.demo.openThreads).toBe(1)
    expect(summary.pages['static-doc'].openThreads).toBe(0)
    const state = (await (await asOwner('GET', '/api/p/demo/state')).json()) as any
    expect(state.me.role).toBe('owner')
    expect(state.threads[0].comments[0].authorName).toBe('Kian')
  })
})

describe('config', () => {
  test('refuses a public bind address', () => {
    expect(() => loadConfig({ PAGES_TEAM_WORKSPACE_ROOT: '/tmp', PAGES_TEAM_OWNER_EMAIL: OWNER, PAGES_TEAM_HOST: '0.0.0.0' })).toThrow()
  })

  test('refuses the test identity together with Access settings', () => {
    expect(() =>
      loadConfig({
        PAGES_TEAM_WORKSPACE_ROOT: '/tmp',
        PAGES_TEAM_OWNER_EMAIL: OWNER,
        PAGES_TEAM_DEV_IDENTITY: '1',
        PAGES_TEAM_ACCESS_TEAM_DOMAIN: 't.cloudflareaccess.com',
        PAGES_TEAM_ACCESS_AUD: 'x',
      }),
    ).toThrow()
  })
})
