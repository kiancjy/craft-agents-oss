/**
 * Team server settings, read from environment variables.
 *
 * The systemd unit loads them from ~/.config/craft-agents/pages-team.env.
 * See deploy/pages-team.env.example for the full list.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { AccessConfig } from './identity.ts'
import { nameFromEmail } from './identity.ts'
import { normalizeEmail } from './roles.ts'
import { DEFAULT_OWNER_PORT, DEFAULT_OWNER_SECRET_FILE, DEFAULT_TEAM_PORT, expandHome } from './defaults.ts'

export interface TeamServerConfig {
  workspaceRoot: string
  ownerEmail: string
  ownerName: string
  allowedDomain: string
  /** Bind address for both ports. Must stay 127.0.0.1: the tunnel connects locally. */
  host: string
  teamPort: number
  ownerPort: number
  /** The public address of the team link, e.g. https://pages.getincredible.com */
  publicUrl: string | null
  access: AccessConfig | null
  ownerSecretFile: string
  devIdentity: boolean
}

function required(env: Record<string, string | undefined>, key: string): string {
  const value = env[key]?.trim()
  if (!value) throw new Error(`Missing setting ${key}`)
  return value
}

function port(value: string | undefined, fallback: number): number {
  if (!value) return fallback
  const n = Number(value)
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`Invalid port: ${value}`)
  return n
}

export function loadConfig(env: Record<string, string | undefined> = process.env): TeamServerConfig {
  const ownerEmail = normalizeEmail(required(env, 'PAGES_TEAM_OWNER_EMAIL'))
  const teamDomain = env.PAGES_TEAM_ACCESS_TEAM_DOMAIN?.trim()
  const audience = env.PAGES_TEAM_ACCESS_AUD?.trim()
  const devIdentity = env.PAGES_TEAM_DEV_IDENTITY === '1'
  const host = env.PAGES_TEAM_HOST?.trim() || '127.0.0.1'

  if (host !== '127.0.0.1' && host !== '::1' && host !== 'localhost') {
    throw new Error('PAGES_TEAM_HOST must be a local address. The tunnel connects to the local address.')
  }
  if ((teamDomain && !audience) || (!teamDomain && audience)) {
    throw new Error('Set both PAGES_TEAM_ACCESS_TEAM_DOMAIN and PAGES_TEAM_ACCESS_AUD, or neither.')
  }
  if (devIdentity && teamDomain) {
    throw new Error('PAGES_TEAM_DEV_IDENTITY cannot be used together with Cloudflare Access settings.')
  }

  const teamPort = port(env.PAGES_TEAM_PORT, DEFAULT_TEAM_PORT)
  const ownerPort = port(env.PAGES_TEAM_OWNER_PORT, DEFAULT_OWNER_PORT)
  if (teamPort === ownerPort) throw new Error('The team port and the owner port must be different.')

  return {
    workspaceRoot: expandHome(required(env, 'PAGES_TEAM_WORKSPACE_ROOT')),
    ownerEmail,
    ownerName: env.PAGES_TEAM_OWNER_NAME?.trim() || nameFromEmail(ownerEmail),
    allowedDomain: (env.PAGES_TEAM_ALLOWED_DOMAIN?.trim() || 'getincredible.com').toLowerCase(),
    host,
    teamPort,
    ownerPort,
    publicUrl: env.PAGES_TEAM_PUBLIC_URL?.trim().replace(/\/+$/, '') || null,
    access: teamDomain && audience ? { teamDomain, audience } : null,
    ownerSecretFile: expandHome(env.PAGES_TEAM_OWNER_SECRET_FILE?.trim() || DEFAULT_OWNER_SECRET_FILE),
    devIdentity,
  }
}

/** Read the owner secret, or create it (mode 600) on first start. */
export function ensureOwnerSecret(path: string): string {
  if (existsSync(path)) {
    const secret = readFileSync(path, 'utf-8').trim()
    if (secret.length < 32) throw new Error(`Owner secret in ${path} is too short`)
    chmodSync(path, 0o600)
    return secret
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const secret = randomBytes(32).toString('base64url')
  writeFileSync(path, `${secret}\n`, { mode: 0o600 })
  return secret
}
