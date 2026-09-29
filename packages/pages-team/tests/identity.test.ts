import { describe, expect, test } from 'bun:test'
import { AccessVerifier, TeamIdentityResolver, cameThroughCloudflare, nameFromEmail } from '../src/identity.ts'

const TEAM = 'incredible.cloudflareaccess.com'
const AUD = 'aud-tag-123'

function b64url(data: ArrayBuffer | Uint8Array | string): string {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data)
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export async function makeSigner() {
  const pair = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair
  const jwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey
  const kid = 'key-1'
  const jwks = { keys: [{ kid, kty: 'RSA', alg: 'RS256', n: jwk.n, e: jwk.e }] }
  let certFetches = 0
  const fetchImpl = async (url: string) => {
    if (url === `https://${TEAM}/cdn-cgi/access/certs`) {
      certFetches++
      return Response.json(jwks)
    }
    return new Response('no', { status: 404 })
  }
  async function sign(claims: Record<string, unknown>, options: { key?: CryptoKey; kid?: string } = {}) {
    const header = b64url(JSON.stringify({ alg: 'RS256', kid: options.kid ?? kid, typ: 'JWT' }))
    const payload = b64url(JSON.stringify(claims))
    const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', options.key ?? pair.privateKey, new TextEncoder().encode(`${header}.${payload}`))
    return `${header}.${payload}.${b64url(sig)}`
  }
  const nowS = Math.floor(Date.now() / 1000)
  const good = (email = 'yas@getincredible.com') => ({ aud: [AUD], email, exp: nowS + 600, iat: nowS, iss: `https://${TEAM}` })
  return { sign, good, fetchImpl, certFetches: () => certFetches }
}

describe('AccessVerifier', () => {
  test('accepts a valid token and returns the lower-case email', async () => {
    const s = await makeSigner()
    const v = new AccessVerifier({ teamDomain: TEAM, audience: AUD }, s.fetchImpl)
    expect(await v.verify(await s.sign(s.good('Yas@GetIncredible.com')))).toBe('yas@getincredible.com')
  })

  test('refuses no token, a garbage token, and alg none', async () => {
    const s = await makeSigner()
    const v = new AccessVerifier({ teamDomain: TEAM, audience: AUD }, s.fetchImpl)
    expect(await v.verify(null)).toBeNull()
    expect(await v.verify('not.a.token')).toBeNull()
    const none = `${b64url(JSON.stringify({ alg: 'none', kid: 'key-1' }))}.${b64url(JSON.stringify(s.good()))}.`
    expect(await v.verify(none)).toBeNull()
  })

  test('refuses a token signed by a different key (a false sign-in proof)', async () => {
    const s = await makeSigner()
    const other = (await crypto.subtle.generateKey(
      { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true,
      ['sign', 'verify'],
    )) as CryptoKeyPair
    const v = new AccessVerifier({ teamDomain: TEAM, audience: AUD }, s.fetchImpl)
    expect(await v.verify(await s.sign(s.good(), { key: other.privateKey }))).toBeNull()
  })

  test('refuses a changed payload', async () => {
    const s = await makeSigner()
    const v = new AccessVerifier({ teamDomain: TEAM, audience: AUD }, s.fetchImpl)
    const [h, , sig] = (await s.sign(s.good())).split('.')
    const forged = `${h}.${b64url(JSON.stringify(s.good('kian@getincredible.com')))}.${sig}`
    expect(await v.verify(forged)).toBeNull()
  })

  test('refuses an expired token, a wrong audience, and a wrong issuer', async () => {
    const s = await makeSigner()
    const v = new AccessVerifier({ teamDomain: TEAM, audience: AUD }, s.fetchImpl)
    expect(await v.verify(await s.sign({ ...s.good(), exp: Math.floor(Date.now() / 1000) - 3600 }))).toBeNull()
    expect(await v.verify(await s.sign({ ...s.good(), aud: ['other-app'] }))).toBeNull()
    expect(await v.verify(await s.sign({ ...s.good(), iss: 'https://evil.cloudflareaccess.com' }))).toBeNull()
  })

  test('an unknown key id triggers at most one key refresh', async () => {
    const s = await makeSigner()
    const v = new AccessVerifier({ teamDomain: TEAM, audience: AUD }, s.fetchImpl)
    await v.verify(await s.sign(s.good()))
    expect(s.certFetches()).toBe(1)
    expect(await v.verify(await s.sign(s.good(), { kid: 'unknown' }))).toBeNull()
    expect(await v.verify(await s.sign(s.good(), { kid: 'unknown' }))).toBeNull()
    expect(s.certFetches()).toBe(1)
  })
})

describe('TeamIdentityResolver', () => {
  test('without Access settings and without the test identity, nobody signs in', async () => {
    const r = new TeamIdentityResolver({ access: null, devIdentity: false })
    expect(await r.resolve(new Request('http://x/', { headers: { 'x-dev-email': 'yas@getincredible.com' } }))).toBeNull()
  })

  test('the test identity refuses requests that came through Cloudflare', async () => {
    const r = new TeamIdentityResolver({ access: null, devIdentity: true })
    const local = new Request('http://x/', { headers: { 'x-dev-email': 'yas@getincredible.com' } })
    expect(await r.resolve(local)).toEqual({ email: 'yas@getincredible.com', name: 'Yas' })
    const tunnel = new Request('http://x/', { headers: { 'x-dev-email': 'yas@getincredible.com', 'cf-ray': 'abc' } })
    expect(await r.resolve(tunnel)).toBeNull()
  })

  test('with Access settings, the X-Dev-Email header is ignored', async () => {
    const s = await makeSigner()
    const r = new TeamIdentityResolver({ access: { teamDomain: TEAM, audience: AUD }, devIdentity: false, fetchImpl: s.fetchImpl })
    expect(await r.resolve(new Request('http://x/', { headers: { 'x-dev-email': 'kian@getincredible.com' } }))).toBeNull()
    const ok = await r.resolve(new Request('http://x/', { headers: { 'cf-access-jwt-assertion': await s.sign(s.good()) } }))
    expect(ok?.email).toBe('yas@getincredible.com')
  })

  test('helpers', () => {
    expect(nameFromEmail('yas.khan@getincredible.com')).toBe('Yas Khan')
    expect(cameThroughCloudflare(new Headers({ 'cf-connecting-ip': '1.2.3.4' }))).toBe(true)
    expect(cameThroughCloudflare(new Headers({}))).toBe(false)
  })
})
