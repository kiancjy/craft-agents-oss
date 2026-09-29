/**
 * @craft-agent/pages-team — team access for Pages.
 *
 * Runtime-neutral exports only (the role table and the owner-port client).
 * The server itself (server.ts, store.ts) is Bun-only and is not exported.
 */

export * from './roles.ts'
export { TeamOwnerClient, isAllowedOwnerCall, type OwnerCallResult, type TeamServerInfo } from './owner-client.ts'
