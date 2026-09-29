/**
 * Owner-port client — how the Craft Agents server and the agent reach the
 * team server. Runtime-neutral (Bun and Node): fetch + fs only.
 *
 * Reads the owner secret from the mode-600 file that the team server creates
 * on first start. If the file or the server is missing, every call returns
 * `{ available: false }` so the app can show "not set up" and carry on.
 */

import { readFileSync } from 'node:fs'
import { DEFAULT_OWNER_PORT, DEFAULT_OWNER_SECRET_FILE, expandHome } from './defaults.ts'

export interface OwnerClientOptions {
  baseUrl?: string
  secretFile?: string
  timeoutMs?: number
}

export type OwnerCallResult =
  | { available: true; ok: true; status: number; data: unknown }
  | { available: true; ok: false; status: number; error: { code: string; message: string } }
  | { available: false; reason: string }

export interface TeamServerInfo {
  workspaceRoot: string
  publicUrl: string | null
  allowedDomain: string
  ownerEmail: string
  signIn: 'cloudflare-access' | 'test-identity' | 'none'
}

/** Methods and paths the app may send through. Everything else is refused here. */
const ALLOWED: Array<[string, RegExp]> = [
  ['GET', /^\/api\/info$/],
  ['GET', /^\/api\/summary$/],
  ['GET', /^\/api\/p\/[a-z0-9-]+\/(state|threads|people|changes)$/],
  ['POST', /^\/api\/p\/[a-z0-9-]+\/threads$/],
  ['POST', /^\/api\/p\/[a-z0-9-]+\/threads\/thr_[A-Za-z0-9-]+\/(replies|resolve)$/],
  ['PATCH', /^\/api\/p\/[a-z0-9-]+\/comments\/cmt_[A-Za-z0-9-]+$/],
  ['DELETE', /^\/api\/p\/[a-z0-9-]+\/comments\/cmt_[A-Za-z0-9-]+$/],
  ['PUT', /^\/api\/p\/[a-z0-9-]+\/(people|general-rule)$/],
  ['DELETE', /^\/api\/p\/[a-z0-9-]+\/people$/],
]

export function isAllowedOwnerCall(method: string, path: string): boolean {
  return ALLOWED.some(([m, re]) => m === method && re.test(path))
}

export class TeamOwnerClient {
  private readonly baseUrl: string
  private readonly secretFile: string
  private readonly timeoutMs: number

  constructor(options: OwnerClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? process.env.PAGES_TEAM_OWNER_URL ?? `http://127.0.0.1:${DEFAULT_OWNER_PORT}`).replace(/\/+$/, '')
    this.secretFile = expandHome(options.secretFile ?? process.env.PAGES_TEAM_OWNER_SECRET_FILE ?? DEFAULT_OWNER_SECRET_FILE)
    this.timeoutMs = options.timeoutMs ?? 3000
  }

  private secret(): string | null {
    try {
      return readFileSync(this.secretFile, 'utf-8').trim() || null
    } catch {
      return null
    }
  }

  /**
   * One call to the owner port. `path` is the /api path; a query string is
   * allowed only for DELETE /people (?email=).
   */
  async call(method: string, path: string, body?: unknown): Promise<OwnerCallResult> {
    const upper = method.toUpperCase()
    const [pathname, query = ''] = path.split('?', 2)
    if (!isAllowedOwnerCall(upper, pathname!)) {
      return { available: true, ok: false, status: 400, error: { code: 'bad-request', message: 'Call not allowed.' } }
    }
    if (query && !(upper === 'DELETE' && /^email=[^&]+$/.test(query))) {
      return { available: true, ok: false, status: 400, error: { code: 'bad-request', message: 'Call not allowed.' } }
    }
    const secret = this.secret()
    if (!secret) return { available: false, reason: 'The team server is not set up on this machine.' }

    let res: Response
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method: upper,
        headers: {
          authorization: `Bearer ${secret}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch {
      return { available: false, reason: 'The team server is not running.' }
    }
    let data: unknown = null
    try {
      data = await res.json()
    } catch {
      return { available: false, reason: 'The team server gave an invalid answer.' }
    }
    if (!res.ok) {
      const err = (data as { error?: { code?: string; message?: string } } | null)?.error
      return {
        available: true,
        ok: false,
        status: res.status,
        error: { code: err?.code ?? 'server', message: err?.message ?? 'Team server error.' },
      }
    }
    return { available: true, ok: true, status: res.status, data }
  }

  /** Server info, or null when the team server is not available. */
  async info(): Promise<TeamServerInfo | null> {
    const result = await this.call('GET', '/api/info')
    return result.available && result.ok ? (result.data as TeamServerInfo) : null
  }
}
