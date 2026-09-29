/**
 * Sign-in check for the team port (9200).
 *
 * Cloudflare Access sits in front of the tunnel and does the Google sign-in.
 * On every request it forwards, it adds a signed token in the
 * `Cf-Access-Jwt-Assertion` header. This module verifies that token:
 * RS256 signature against the team's published keys, the application
 * audience tag, the issuer, and the expiry. A request without a valid token
 * gets no identity, so the server refuses it.
 *
 * The domain check (`@getincredible.com`) is NOT done here — roles.ts does
 * it for every request, so a gate misconfiguration cannot widen access.
 *
 * Test identity: for local tests only, `devIdentity` accepts an
 * `X-Dev-Email` header. It refuses any request that carries a Cloudflare
 * header, so it cannot work through the tunnel. The service file never
 * enables it.
 */

import { normalizeEmail } from './roles.ts'

export interface Identity {
  email: string
  name: string
}

export interface AccessConfig {
  /** e.g. "incredible.cloudflareaccess.com" */
  teamDomain: string
  /** The Application Audience (AUD) tag of the Access application */
  audience: string
}

interface Jwk {
  kid: string
  kty: string
  alg?: string
  n: string
  e: string
}

const JWKS_TTL_MS = 60 * 60 * 1000
const JWKS_MIN_REFETCH_MS = 30 * 1000
const CLOCK_SKEW_S = 60

function base64UrlDecode(input: string): Uint8Array<ArrayBuffer> {
  const pad = input.length % 4 === 0 ? '' : '='.repeat(4 - (input.length % 4))
  const b64 = (input + pad).replace(/-/g, '+').replace(/_/g, '/')
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0))
}

function decodeJson(part: string): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(base64UrlDecode(part))) as Record<string, unknown>
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

export class AccessVerifier {
  private keys = new Map<string, CryptoKey>()
  private fetchedAt = 0
  private lastAttempt = 0

  constructor(
    private readonly config: AccessConfig,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  get issuer(): string {
    return `https://${this.config.teamDomain}`
  }

  private async refreshKeys(force: boolean): Promise<void> {
    const t = this.now()
    if (!force && this.keys.size > 0 && t - this.fetchedAt < JWKS_TTL_MS) return
    if (t - this.lastAttempt < JWKS_MIN_REFETCH_MS && this.keys.size > 0) return
    this.lastAttempt = t
    const res = await this.fetchImpl(`${this.issuer}/cdn-cgi/access/certs`)
    if (!res.ok) throw new Error(`Access certs fetch failed: ${res.status}`)
    const body = (await res.json()) as { keys?: Jwk[] }
    const next = new Map<string, CryptoKey>()
    for (const jwk of body.keys ?? []) {
      if (jwk.kty !== 'RSA' || !jwk.kid) continue
      const key = await crypto.subtle.importKey(
        'jwk',
        { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        false,
        ['verify'],
      )
      next.set(jwk.kid, key)
    }
    this.keys = next
    this.fetchedAt = t
  }

  /** The verified email, or null for a missing, forged, expired, or foreign token. */
  async verify(token: string | null): Promise<string | null> {
    if (!token) return null
    const parts = token.split('.')
    if (parts.length !== 3) return null
    let header: Record<string, unknown>
    let payload: Record<string, unknown>
    try {
      header = decodeJson(parts[0]!)
      payload = decodeJson(parts[1]!)
    } catch {
      return null
    }
    if (header.alg !== 'RS256' || typeof header.kid !== 'string') return null

    try {
      await this.refreshKeys(false)
      if (!this.keys.has(header.kid)) await this.refreshKeys(true)
    } catch {
      return null
    }
    const key = this.keys.get(header.kid)
    if (!key) return null

    const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
    let valid = false
    try {
      valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, base64UrlDecode(parts[2]!), signed)
    } catch {
      return null
    }
    if (!valid) return null

    const nowS = Math.floor(this.now() / 1000)
    if (typeof payload.exp !== 'number' || payload.exp + CLOCK_SKEW_S < nowS) return null
    if (typeof payload.nbf === 'number' && payload.nbf - CLOCK_SKEW_S > nowS) return null
    if (payload.iss !== this.issuer) return null
    const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud]
    if (!aud.includes(this.config.audience)) return null
    if (typeof payload.email !== 'string' || !payload.email.includes('@')) return null
    return normalizeEmail(payload.email)
  }
}

/**
 * A display name from an email: "yas.khan@x" → "Yas Khan".
 * Used when the identity service does not return a name.
 */
export function nameFromEmail(email: string): string {
  const local = email.split('@')[0] ?? email
  return (
    local
      .split(/[._-]+/)
      .filter(Boolean)
      .map(part => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ') || email
  )
}

/**
 * Best-effort full name from Cloudflare Access (the Google profile name).
 * Falls back to the email-derived name. Cached for one hour per email.
 */
export class NameResolver {
  private cache = new Map<string, { name: string; at: number }>()

  constructor(
    private readonly teamDomain: string | null,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  async resolve(email: string, token: string | null): Promise<string> {
    const hit = this.cache.get(email)
    if (hit && this.now() - hit.at < JWKS_TTL_MS) return hit.name
    let name = nameFromEmail(email)
    if (this.teamDomain && token) {
      try {
        const res = await this.fetchImpl(`https://${this.teamDomain}/cdn-cgi/access/get-identity`, {
          headers: { cookie: `CF_Authorization=${token}` },
          signal: AbortSignal.timeout(2000),
        })
        if (res.ok) {
          const body = (await res.json()) as { name?: unknown; email?: unknown }
          if (typeof body.name === 'string' && body.name.trim() && normalizeEmail(String(body.email ?? '')) === email) {
            name = body.name.trim()
          }
        }
      } catch {
        // keep the fallback name
      }
    }
    this.cache.set(email, { name, at: this.now() })
    return name
  }
}

/** Headers that only a request through Cloudflare carries. */
const CLOUDFLARE_HEADERS = ['cf-access-jwt-assertion', 'cf-ray', 'cf-connecting-ip', 'cf-ipcountry', 'cdn-loop']

export function cameThroughCloudflare(headers: Headers): boolean {
  return CLOUDFLARE_HEADERS.some(h => headers.has(h))
}

export interface IdentityResolverOptions {
  access: AccessConfig | null
  devIdentity: boolean
  fetchImpl?: FetchLike
  now?: () => number
}

/** Resolves the identity of a request on the team port. */
export class TeamIdentityResolver {
  private readonly verifier: AccessVerifier | null
  private readonly names: NameResolver

  constructor(private readonly options: IdentityResolverOptions) {
    this.verifier = options.access ? new AccessVerifier(options.access, options.fetchImpl, options.now) : null
    this.names = new NameResolver(options.access?.teamDomain ?? null, options.fetchImpl, options.now)
  }

  async resolve(req: Request): Promise<Identity | null> {
    if (this.options.devIdentity) {
      if (cameThroughCloudflare(req.headers)) return null
      const email = req.headers.get('x-dev-email')
      if (!email || !email.includes('@')) return null
      const normalized = normalizeEmail(email)
      return { email: normalized, name: req.headers.get('x-dev-name')?.trim() || nameFromEmail(normalized) }
    }
    if (!this.verifier) return null
    const token = req.headers.get('cf-access-jwt-assertion')
    const email = await this.verifier.verify(token)
    if (!email) return null
    return { email, name: await this.names.resolve(email, token) }
  }
}
