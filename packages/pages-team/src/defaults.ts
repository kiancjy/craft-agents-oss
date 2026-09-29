/**
 * Defaults shared by the team server and its owner-port client.
 * Runtime-neutral (Bun and Node).
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

export const DEFAULT_TEAM_PORT = 9200
export const DEFAULT_OWNER_PORT = 9201
export const DEFAULT_OWNER_SECRET_FILE = '~/.craft-agent/pages-team/owner-secret'

export function expandHome(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/')) return join(homedir(), path.slice(2))
  return path
}
