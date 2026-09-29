/**
 * Team access for Pages (fork addition) — renderer-side client.
 *
 * Every call goes through the single `pagesTeam:call` channel to the team
 * server's owner port (see server-core handlers/rpc/pages-team.ts).
 *
 * Two small shared stores live here so that separate components agree
 * without new props through upstream files:
 * - the per-workspace summary (open thread counts for tiles and buttons),
 * - which page has its comment panel open.
 */

import * as React from 'react'
import type { OwnerCallResult, TeamServerInfo } from '@craft-agent/pages-team/owner-client'

export type { TeamServerInfo }

export interface TeamComment {
  id: string
  threadId: string
  authorEmail: string
  authorName: string
  body: string
  createdAt: number
  editedAt: number | null
  deleted: boolean
}

export interface TeamThread {
  id: string
  createdBy: string
  createdByName: string
  createdAt: number
  resolvedAt: number | null
  resolvedBy: string | null
  comments: TeamComment[]
}

export type TeamRoleName = 'viewer' | 'commenter' | 'editor' | 'admin'
export type GeneralRuleName = 'none' | 'viewer' | 'commenter'

export interface TeamPeopleView {
  owner: { email: string; name: string }
  people: Array<{ email: string; role: TeamRoleName; addedBy: string; addedAt: number }>
  generalRule: GeneralRuleName
  allowedDomain: string
}

export interface TeamPageState {
  page: { slug: string; name: string }
  me: { email: string; name: string; role: string }
  threads: TeamThread[]
  people: TeamPeopleView | null
  teamLink: string | null
}

export interface TeamSummary {
  pages: Record<string, { openThreads: number; people: number; generalRule: GeneralRuleName; teamLink: string | null }>
}

export type TeamResult<T> =
  | { kind: 'ok'; data: T }
  | { kind: 'unavailable'; reason: string }
  | { kind: 'error'; code: string; message: string }

export async function teamCall<T>(workspaceId: string, method: string, path: string, body?: unknown): Promise<TeamResult<T>> {
  let result: OwnerCallResult
  try {
    result = await window.electronAPI.pagesTeamCall(workspaceId, method, path, body)
  } catch (err) {
    // Older server without the channel, or transport failure.
    return { kind: 'unavailable', reason: err instanceof Error ? err.message : 'Team access is not available.' }
  }
  if (!result.available) return { kind: 'unavailable', reason: result.reason }
  if (!result.ok) return { kind: 'error', code: result.error.code, message: result.error.message }
  return { kind: 'ok', data: result.data as T }
}

export function pagePath(slug: string, rest: string): string {
  return `/api/p/${encodeURIComponent(slug)}${rest}`
}

// ----------------------------------------------------------------------------
// Summary store (open thread counts), shared by tiles, buttons, and panels
// ----------------------------------------------------------------------------

const SUMMARY_TTL_MS = 15_000

interface SummaryEntry {
  at: number
  value: TeamSummary | null
  pending: Promise<void> | null
}

const summaries = new Map<string, SummaryEntry>()
const summaryListeners = new Set<() => void>()

function emitSummary(): void {
  for (const listener of summaryListeners) listener()
}

function loadSummary(workspaceId: string, force = false): void {
  const entry = summaries.get(workspaceId) ?? { at: 0, value: null, pending: null }
  summaries.set(workspaceId, entry)
  if (entry.pending) return
  if (!force && Date.now() - entry.at < SUMMARY_TTL_MS) return
  entry.pending = teamCall<TeamSummary>(workspaceId, 'GET', '/api/summary').then(result => {
    entry.value = result.kind === 'ok' ? result.data : null
    entry.at = Date.now()
    entry.pending = null
    emitSummary()
  })
}

/** Call after a change in a panel, so counts on tiles and buttons update. */
export function invalidateTeamSummary(workspaceId: string): void {
  loadSummary(workspaceId, true)
}

/** Team summary for a workspace, or null when team access is not available. */
export function useTeamSummary(workspaceId: string | null | undefined): TeamSummary | null {
  const subscribe = React.useCallback((listener: () => void) => {
    summaryListeners.add(listener)
    return () => summaryListeners.delete(listener)
  }, [])
  const value = React.useSyncExternalStore(subscribe, () => (workspaceId ? summaries.get(workspaceId)?.value ?? null : null))
  React.useEffect(() => {
    if (!workspaceId) return
    loadSummary(workspaceId)
    const timer = window.setInterval(() => loadSummary(workspaceId), SUMMARY_TTL_MS)
    return () => window.clearInterval(timer)
  }, [workspaceId])
  return value
}

// ----------------------------------------------------------------------------
// Which page has its comment panel open
// ----------------------------------------------------------------------------

const openPanels = new Set<string>()
const panelListeners = new Set<() => void>()

export function useTeamPanelOpen(pageSlug: string): [boolean, (open: boolean) => void] {
  const subscribe = React.useCallback((listener: () => void) => {
    panelListeners.add(listener)
    return () => panelListeners.delete(listener)
  }, [])
  const open = React.useSyncExternalStore(subscribe, () => openPanels.has(pageSlug))
  const setOpen = React.useCallback(
    (next: boolean) => {
      if (next) openPanels.add(pageSlug)
      else openPanels.delete(pageSlug)
      for (const listener of panelListeners) listener()
    },
    [pageSlug],
  )
  return [open, setOpen]
}

export function formatTeamTime(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}
