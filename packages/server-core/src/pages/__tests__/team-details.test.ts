import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TeamOwnerClient } from '@craft-agent/pages-team/owner-client'
import { loadPageTeamDetails } from '../team-details'

const SECRET = 'x'.repeat(40)
const workspaceRoot = mkdtempSync(join(tmpdir(), 'team-details-'))
const secretFile = join(workspaceRoot, 'secret')
writeFileSync(secretFile, SECRET)

let server: ReturnType<typeof Bun.serve>
let client: TeamOwnerClient

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req) {
      if (req.headers.get('authorization') !== `Bearer ${SECRET}`) return Response.json({ error: { code: 'not-signed-in', message: 'no' } }, { status: 401 })
      const path = new URL(req.url).pathname
      if (path === '/api/info') {
        return Response.json({ workspaceRoot, publicUrl: 'https://pages.example', allowedDomain: 'getincredible.com', ownerEmail: 'kian@getincredible.com', signIn: 'test-identity' })
      }
      if (path === '/api/p/demo/state') {
        return Response.json({
          teamLink: 'https://pages.example/p/demo',
          people: { people: [{ email: 'yas@getincredible.com', role: 'admin' }], generalRule: 'viewer' },
          threads: [
            { id: 'thr_1', createdAt: 0, resolvedAt: null, resolvedBy: null, comments: [
              { authorName: 'Yas', authorEmail: 'yas@getincredible.com', body: 'Open point', createdAt: 0, editedAt: null, deleted: false },
              { authorName: 'Yas', authorEmail: 'yas@getincredible.com', body: '', createdAt: 1, editedAt: null, deleted: true },
            ] },
            { id: 'thr_2', createdAt: 0, resolvedAt: 5, resolvedBy: 'kian@getincredible.com', comments: [] },
          ],
        })
      }
      return Response.json({ error: { code: 'not-found', message: 'no' } }, { status: 404 })
    },
  })
  client = new TeamOwnerClient({ baseUrl: `http://127.0.0.1:${server.port}`, secretFile })
})

afterAll(() => server.stop(true))

describe('loadPageTeamDetails', () => {
  it('returns open and resolved threads without deleted comments', async () => {
    const team = await loadPageTeamDetails(workspaceRoot, 'demo', client)
    expect(team?.openThreadCount).toBe(1)
    expect(team?.openThreads[0]?.comments).toEqual([{ author: 'Yas', email: 'yas@getincredible.com', at: new Date(0).toISOString(), text: 'Open point' }])
    expect(team?.resolvedThreadCount).toBe(1)
    expect(team?.people).toEqual([{ email: 'yas@getincredible.com', role: 'admin' }])
    expect(team?.generalRule).toBe('viewer')
  })

  it('returns nothing for a different workspace', async () => {
    expect(await loadPageTeamDetails(mkdtempSync(join(tmpdir(), 'other-')), 'demo', client)).toBeUndefined()
  })

  it('returns nothing when the team server is not set up', async () => {
    const missing = new TeamOwnerClient({ baseUrl: `http://127.0.0.1:${server.port}`, secretFile: join(workspaceRoot, 'nope') })
    expect(await loadPageTeamDetails(workspaceRoot, 'demo', missing)).toBeUndefined()
  })

  it('returns nothing when the team server is not running', async () => {
    const down = new TeamOwnerClient({ baseUrl: 'http://127.0.0.1:1', secretFile })
    expect(await loadPageTeamDetails(workspaceRoot, 'demo', down)).toBeUndefined()
  })
})

describe('TeamOwnerClient allow-list', () => {
  it('refuses paths outside the list without a network call', async () => {
    const result = await client.call('GET', '/api/p/demo/../../etc')
    expect(result).toEqual({ available: true, ok: false, status: 400, error: { code: 'bad-request', message: 'Call not allowed.' } })
    expect((await client.call('POST', '/api/summary')).available).toBe(true)
    expect(await client.call('DELETE', '/api/p/demo/people?email=a%40b&x=1')).toEqual(
      expect.objectContaining({ ok: false, status: 400 }),
    )
  })
})
