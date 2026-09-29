/**
 * Team store — one SQLite file for each page, at pages/{slug}/team/team.sqlite.
 *
 * Holds the people and their roles, the general rule, the threads and
 * comments, and a change record that names the person for every change.
 *
 * BUN-ONLY (bun:sqlite). Only the team server opens this file. The Craft
 * Agents server and the agent reach it through the team server's owner port.
 *
 * Concurrency: WAL mode plus a busy timeout. Every write is one short
 * transaction, so two comments saved at the same time are both kept.
 */

import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { type GeneralRule, type TeamRole, isGeneralRule, isTeamRole, normalizeEmail } from './roles.ts'

export const TEAM_DIRNAME = 'team'
export const TEAM_STORE_FILENAME = 'team.sqlite'

/** Bounds on user input. */
export const MAX_COMMENT_CHARS = 5000
export const MAX_PEOPLE = 500
const MAX_NAME_CHARS = 200

export interface Person {
  email: string
  role: TeamRole
  addedBy: string
  addedAt: number
}

export interface Comment {
  id: string
  threadId: string
  authorEmail: string
  authorName: string
  body: string
  createdAt: number
  editedAt: number | null
  deleted: boolean
}

export interface Thread {
  id: string
  createdBy: string
  createdByName: string
  createdAt: number
  resolvedAt: number | null
  resolvedBy: string | null
  comments: Comment[]
}

export interface ChangeRecord {
  id: number
  at: number
  actorEmail: string
  action: string
  detail: Record<string, unknown>
}

export interface Actor {
  email: string
  name: string
}

export class TeamStoreError extends Error {
  constructor(
    readonly code: 'not-found' | 'invalid' | 'forbidden' | 'limit',
    message: string,
  ) {
    super(message)
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS people (
  email TEXT PRIMARY KEY,
  role TEXT NOT NULL,
  added_by TEXT NOT NULL,
  added_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY,
  created_by TEXT NOT NULL,
  created_by_name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER,
  resolved_by TEXT
);
CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES threads(id),
  author_email TEXT NOT NULL,
  author_name TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  edited_at INTEGER,
  deleted_at INTEGER
);
CREATE INDEX IF NOT EXISTS comments_thread ON comments(thread_id, created_at);
CREATE TABLE IF NOT EXISTS changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  actor_email TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT NOT NULL
);
`

interface PersonRow { email: string; role: string; added_by: string; added_at: number }
interface ThreadRow {
  id: string
  created_by: string
  created_by_name: string
  created_at: number
  resolved_at: number | null
  resolved_by: string | null
}
interface CommentRow {
  id: string
  thread_id: string
  author_email: string
  author_name: string
  body: string
  created_at: number
  edited_at: number | null
  deleted_at: number | null
}

export function getTeamStorePath(pageFolder: string): string {
  return join(pageFolder, TEAM_DIRNAME, TEAM_STORE_FILENAME)
}

function cleanBody(body: unknown): string {
  if (typeof body !== 'string') throw new TeamStoreError('invalid', 'The comment is empty.')
  const trimmed = body.trim()
  if (!trimmed) throw new TeamStoreError('invalid', 'The comment is empty.')
  if (trimmed.length > MAX_COMMENT_CHARS) {
    throw new TeamStoreError('invalid', `A comment can have ${MAX_COMMENT_CHARS} characters or fewer.`)
  }
  return trimmed
}

function cleanName(name: string): string {
  return name.trim().slice(0, MAX_NAME_CHARS) || 'Unknown'
}

export class TeamStore {
  private readonly db: Database
  private readonly now: () => number

  private constructor(db: Database, now: () => number) {
    this.db = db
    this.now = now
  }

  /** Open (and create if missing) the store for one page folder. */
  static open(pageFolder: string, options: { now?: () => number } = {}): TeamStore {
    mkdirSync(join(pageFolder, TEAM_DIRNAME), { recursive: true, mode: 0o700 })
    const db = new Database(getTeamStorePath(pageFolder), { create: true })
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA busy_timeout = 5000')
    db.exec('PRAGMA foreign_keys = ON')
    db.exec(SCHEMA)
    return new TeamStore(db, options.now ?? Date.now)
  }

  close(): void {
    this.db.close()
  }

  // ------------------------------------------------------------------
  // General rule
  // ------------------------------------------------------------------

  getGeneralRule(): GeneralRule {
    const row = this.db.query<{ value: string }, [string]>('SELECT value FROM settings WHERE key = ?').get('general_rule')
    return row && isGeneralRule(row.value) ? row.value : 'none'
  }

  setGeneralRule(rule: GeneralRule, actor: Actor): void {
    if (!isGeneralRule(rule)) throw new TeamStoreError('invalid', 'The rule must be none, viewer, or commenter.')
    const before = this.getGeneralRule()
    this.db.transaction(() => {
      this.db.query('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .run('general_rule', rule)
      this.record(actor, 'general_rule.set', { from: before, to: rule })
    })()
  }

  // ------------------------------------------------------------------
  // People
  // ------------------------------------------------------------------

  listPeople(): Person[] {
    return this.db
      .query<PersonRow, []>('SELECT email, role, added_by, added_at FROM people ORDER BY email')
      .all()
      .filter(row => isTeamRole(row.role))
      .map(row => ({ email: row.email, role: row.role as TeamRole, addedBy: row.added_by, addedAt: row.added_at }))
  }

  getPersonalRole(email: string): TeamRole | null {
    const row = this.db.query<{ role: string }, [string]>('SELECT role FROM people WHERE email = ?').get(normalizeEmail(email))
    return row && isTeamRole(row.role) ? row.role : null
  }

  /** Add a person or change the role. The caller checks the domain and the Owner rule. */
  setPerson(email: string, role: TeamRole, actor: Actor): void {
    if (!isTeamRole(role)) throw new TeamStoreError('invalid', 'Unknown role.')
    const key = normalizeEmail(email)
    const before = this.getPersonalRole(key)
    if (before === null) {
      const count = this.db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM people').get()?.n ?? 0
      if (count >= MAX_PEOPLE) throw new TeamStoreError('limit', `A page can have ${MAX_PEOPLE} people or fewer.`)
    }
    this.db.transaction(() => {
      this.db
        .query('INSERT INTO people (email, role, added_by, added_at) VALUES (?, ?, ?, ?) ON CONFLICT(email) DO UPDATE SET role = excluded.role')
        .run(key, role, normalizeEmail(actor.email), this.now())
      this.record(actor, before === null ? 'person.add' : 'person.role', { email: key, from: before, to: role })
    })()
  }

  removePerson(email: string, actor: Actor): boolean {
    const key = normalizeEmail(email)
    const before = this.getPersonalRole(key)
    if (before === null) return false
    this.db.transaction(() => {
      this.db.query('DELETE FROM people WHERE email = ?').run(key)
      this.record(actor, 'person.remove', { email: key, from: before })
    })()
    return true
  }

  // ------------------------------------------------------------------
  // Threads and comments
  // ------------------------------------------------------------------

  listThreads(): Thread[] {
    const threads = this.db
      .query<ThreadRow, []>('SELECT * FROM threads ORDER BY created_at ASC')
      .all()
    const comments = this.db
      .query<CommentRow, []>('SELECT * FROM comments ORDER BY created_at ASC, rowid ASC')
      .all()
    const byThread = new Map<string, Comment[]>()
    for (const row of comments) {
      const list = byThread.get(row.thread_id) ?? []
      list.push(toComment(row))
      byThread.set(row.thread_id, list)
    }
    return threads.map(row => ({
      id: row.id,
      createdBy: row.created_by,
      createdByName: row.created_by_name,
      createdAt: row.created_at,
      resolvedAt: row.resolved_at,
      resolvedBy: row.resolved_by,
      comments: byThread.get(row.id) ?? [],
    }))
  }

  countOpenThreads(): number {
    return this.db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM threads WHERE resolved_at IS NULL').get()?.n ?? 0
  }

  getThread(threadId: string): Thread | null {
    return this.listThreads().find(t => t.id === threadId) ?? null
  }

  getComment(commentId: string): Comment | null {
    const row = this.db.query<CommentRow, [string]>('SELECT * FROM comments WHERE id = ?').get(commentId)
    return row ? toComment(row) : null
  }

  createThread(body: unknown, actor: Actor): Thread {
    const text = cleanBody(body)
    const threadId = `thr_${randomUUID()}`
    const commentId = `cmt_${randomUUID()}`
    const at = this.now()
    const email = normalizeEmail(actor.email)
    const name = cleanName(actor.name)
    this.db.transaction(() => {
      this.db
        .query('INSERT INTO threads (id, created_by, created_by_name, created_at) VALUES (?, ?, ?, ?)')
        .run(threadId, email, name, at)
      this.db
        .query('INSERT INTO comments (id, thread_id, author_email, author_name, body, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(commentId, threadId, email, name, text, at)
      this.record(actor, 'thread.create', { threadId, commentId })
    })()
    return this.getThread(threadId)!
  }

  addReply(threadId: string, body: unknown, actor: Actor): Comment {
    const text = cleanBody(body)
    const thread = this.db.query<ThreadRow, [string]>('SELECT * FROM threads WHERE id = ?').get(threadId)
    if (!thread) throw new TeamStoreError('not-found', 'This thread no longer exists.')
    const commentId = `cmt_${randomUUID()}`
    this.db.transaction(() => {
      this.db
        .query('INSERT INTO comments (id, thread_id, author_email, author_name, body, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(commentId, threadId, normalizeEmail(actor.email), cleanName(actor.name), text, this.now())
      this.record(actor, 'comment.add', { threadId, commentId })
    })()
    return this.getComment(commentId)!
  }

  editComment(commentId: string, body: unknown, actor: Actor): Comment {
    const text = cleanBody(body)
    const existing = this.getComment(commentId)
    if (!existing || existing.deleted) throw new TeamStoreError('not-found', 'This comment no longer exists.')
    if (existing.authorEmail !== normalizeEmail(actor.email)) {
      throw new TeamStoreError('forbidden', 'You can only edit your own comments.')
    }
    this.db.transaction(() => {
      this.db.query('UPDATE comments SET body = ?, edited_at = ? WHERE id = ?').run(text, this.now(), commentId)
      this.record(actor, 'comment.edit', { commentId, previous: existing.body })
    })()
    return this.getComment(commentId)!
  }

  /** Soft delete: the row stays, the text goes. The change record keeps the old text. */
  deleteComment(commentId: string, actor: Actor): void {
    const existing = this.getComment(commentId)
    if (!existing || existing.deleted) throw new TeamStoreError('not-found', 'This comment no longer exists.')
    if (existing.authorEmail !== normalizeEmail(actor.email)) {
      throw new TeamStoreError('forbidden', 'You can only delete your own comments.')
    }
    this.db.transaction(() => {
      this.db.query("UPDATE comments SET body = '', deleted_at = ? WHERE id = ?").run(this.now(), commentId)
      this.record(actor, 'comment.delete', { commentId, previous: existing.body })
    })()
  }

  /** Resolve or reopen. The caller checks resolve_own_thread / resolve_any_thread. */
  setResolved(threadId: string, resolved: boolean, actor: Actor): Thread {
    const thread = this.getThread(threadId)
    if (!thread) throw new TeamStoreError('not-found', 'This thread no longer exists.')
    this.db.transaction(() => {
      if (resolved) {
        this.db
          .query('UPDATE threads SET resolved_at = ?, resolved_by = ? WHERE id = ?')
          .run(this.now(), normalizeEmail(actor.email), threadId)
      } else {
        this.db.query('UPDATE threads SET resolved_at = NULL, resolved_by = NULL WHERE id = ?').run(threadId)
      }
      this.record(actor, resolved ? 'thread.resolve' : 'thread.reopen', { threadId })
    })()
    return this.getThread(threadId)!
  }

  // ------------------------------------------------------------------
  // Change record
  // ------------------------------------------------------------------

  listChanges(limit = 200): ChangeRecord[] {
    return this.db
      .query<{ id: number; at: number; actor_email: string; action: string; detail: string }, [number]>(
        'SELECT * FROM changes ORDER BY id DESC LIMIT ?',
      )
      .all(limit)
      .map(row => ({
        id: row.id,
        at: row.at,
        actorEmail: row.actor_email,
        action: row.action,
        detail: JSON.parse(row.detail) as Record<string, unknown>,
      }))
  }

  private record(actor: Actor, action: string, detail: Record<string, unknown>): void {
    this.db
      .query('INSERT INTO changes (at, actor_email, action, detail) VALUES (?, ?, ?, ?)')
      .run(this.now(), normalizeEmail(actor.email), action, JSON.stringify(detail))
  }
}

function toComment(row: CommentRow): Comment {
  return {
    id: row.id,
    threadId: row.thread_id,
    authorEmail: row.author_email,
    authorName: row.author_name,
    body: row.deleted_at ? '' : row.body,
    createdAt: row.created_at,
    editedAt: row.edited_at,
    deleted: row.deleted_at !== null,
  }
}
