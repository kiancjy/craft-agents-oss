/**
 * Team access for Pages (fork addition) — the `team` block of get_page.
 *
 * Asks the team server's owner port for the page's threads and people, so
 * the agent can answer "What comments are open on this page?" and act on
 * them. When the team server is not set up, not running, or serves another
 * workspace, get_page returns exactly what upstream returns.
 */

import { realpathSync } from 'node:fs'
import { TeamOwnerClient } from '@craft-agent/pages-team/owner-client'

interface StateComment {
  authorName: string
  authorEmail: string
  body: string
  createdAt: number
  editedAt: number | null
  deleted: boolean
}

interface StateThread {
  id: string
  createdAt: number
  resolvedAt: number | null
  resolvedBy: string | null
  comments: StateComment[]
}

interface StateResponse {
  threads: StateThread[]
  people: { people: Array<{ email: string; role: string }>; generalRule: string } | null
  teamLink: string | null
}

export interface PageTeamDetails {
  teamLink: string | null
  generalRule: string
  people: Array<{ email: string; role: string }>
  openThreadCount: number
  openThreads: PageTeamThread[]
  resolvedThreadCount: number
  resolvedThreads: PageTeamThread[]
}

interface PageTeamThread {
  id: string
  createdAt: string
  resolvedAt?: string
  resolvedBy?: string
  comments: Array<{ author: string; email: string; at: string; text: string; edited?: true }>
}

function samePath(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b)
  } catch {
    return a === b
  }
}

function toThread(thread: StateThread): PageTeamThread {
  return {
    id: thread.id,
    createdAt: new Date(thread.createdAt).toISOString(),
    ...(thread.resolvedAt ? { resolvedAt: new Date(thread.resolvedAt).toISOString() } : {}),
    ...(thread.resolvedBy ? { resolvedBy: thread.resolvedBy } : {}),
    comments: thread.comments
      .filter(c => !c.deleted)
      .map(c => ({
        author: c.authorName,
        email: c.authorEmail,
        at: new Date(c.createdAt).toISOString(),
        text: c.body,
        ...(c.editedAt ? { edited: true as const } : {}),
      })),
  }
}

export async function loadPageTeamDetails(
  workspaceRootPath: string,
  pageSlug: string,
  client: TeamOwnerClient = new TeamOwnerClient({ timeoutMs: 2000 }),
): Promise<PageTeamDetails | undefined> {
  try {
    const info = await client.info()
    if (!info || !samePath(info.workspaceRoot, workspaceRootPath)) return undefined
    const result = await client.call('GET', `/api/p/${encodeURIComponent(pageSlug)}/state`)
    if (!result.available || !result.ok) return undefined
    const state = result.data as StateResponse
    const open = state.threads.filter(t => t.resolvedAt === null)
    const resolved = state.threads.filter(t => t.resolvedAt !== null)
    return {
      teamLink: state.teamLink,
      generalRule: state.people?.generalRule ?? 'none',
      people: state.people?.people.map(p => ({ email: p.email, role: p.role })) ?? [],
      openThreadCount: open.length,
      openThreads: open.map(toThread),
      resolvedThreadCount: resolved.length,
      // The 10 most recent resolved threads are enough context; the rest stay in the team store.
      resolvedThreads: resolved.slice(-10).map(toThread),
    }
  } catch {
    return undefined
  }
}
