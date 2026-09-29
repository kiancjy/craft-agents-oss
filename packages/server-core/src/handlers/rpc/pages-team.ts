/**
 * Team access for Pages (fork addition) — one channel to the team server.
 *
 * The renderer (Electron or WebUI) cannot reach the team server's owner port
 * directly: the WebUI runs on another machine. This handler forwards one
 * call from the Owner's app to the owner port, with the owner secret.
 *
 * Limits:
 * - Only the fixed list of methods and paths in owner-client.ts passes.
 * - The workspace must be the one that the team server serves. For any other
 *   workspace the answer is `{ available: false }`, so no call can reach the
 *   team store of a different workspace.
 */

import { realpathSync } from 'node:fs'
import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import { getWorkspaceByNameOrId } from '@craft-agent/shared/config'
import type { RpcServer } from '@craft-agent/server-core/transport'
import { TeamOwnerClient, type OwnerCallResult } from '@craft-agent/pages-team/owner-client'

export const HANDLED_CHANNELS = [RPC_CHANNELS.pagesTeam.CALL] as const

function samePath(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b)
  } catch {
    return a === b
  }
}

export function registerPagesTeamHandlers(server: RpcServer, client = new TeamOwnerClient()): void {
  server.handle(
    RPC_CHANNELS.pagesTeam.CALL,
    async (_ctx, workspaceId: string, method: string, path: string, body?: unknown): Promise<OwnerCallResult> => {
      const workspace = getWorkspaceByNameOrId(workspaceId)
      if (!workspace) return { available: false, reason: 'Unknown workspace.' }
      if (typeof method !== 'string' || typeof path !== 'string') {
        return { available: true, ok: false, status: 400, error: { code: 'bad-request', message: 'Invalid call.' } }
      }
      const info = await client.info()
      if (!info) return { available: false, reason: 'The team server is not running.' }
      if (!samePath(info.workspaceRoot, workspace.rootPath)) {
        return { available: false, reason: 'Team access serves a different workspace.' }
      }
      if (method === 'GET' && path === '/api/info') {
        return { available: true, ok: true, status: 200, data: info }
      }
      return client.call(method, path, body)
    },
  )
}
