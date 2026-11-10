import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, readFileSync, readdirSync, existsSync, writeFileSync, renameSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { SecureStorageBackend, getMachineCredentialsFilename } from '../backends/secure-storage.ts'
import type { CredentialId } from '../types.ts'

const WORK = 'AAAAAAAA-1111-2222-3333-WORKLAPTOP00'
const HOME = 'BBBBBBBB-4444-5555-6666-HOMELAPTOP00'

const apiKey: CredentialId = { type: 'anthropic_api_key' } as CredentialId

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'craft-creds-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const backend = (machineId: string) => new SecureStorageBackend({ dir, machineId })

/** Create a legacy shared credentials.enc written by `machineId`. */
async function writeLegacyFile(machineId: string, value: string): Promise<Buffer> {
  const b = backend(machineId)
  await b.set(apiKey, { value })
  renameSync(b.filePath, join(dir, 'credentials.enc'))
  return readFileSync(join(dir, 'credentials.enc'))
}

describe('SecureStorageBackend per-machine files', () => {
  it('uses a stable per-machine filename that does not contain the raw machine id', () => {
    const name = getMachineCredentialsFilename(WORK)
    expect(name).toMatch(/^credentials\.[0-9a-f]{12}\.enc$/)
    expect(name).toBe(getMachineCredentialsFilename(WORK))
    expect(name).not.toBe(getMachineCredentialsFilename(HOME))
    expect(name).not.toContain(WORK)
  })

  it('keeps each machine\'s credentials separate in a shared (synced) directory', async () => {
    await backend(WORK).set(apiKey, { value: 'work-key' })
    await backend(HOME).set(apiKey, { value: 'home-key' })

    // Fresh instances (no in-memory cache) — as after an app restart on each laptop
    expect((await backend(WORK).get(apiKey))?.value).toBe('work-key')
    expect((await backend(HOME).get(apiKey))?.value).toBe('home-key')
    expect(readdirSync(dir).sort()).toEqual(
      [getMachineCredentialsFilename(WORK), getMachineCredentialsFilename(HOME)].sort(),
    )
  })

  it('imports a readable legacy credentials.enc once and leaves it byte-identical', async () => {
    const before = await writeLegacyFile(WORK, 'legacy-key')

    const work = backend(WORK)
    expect((await work.get(apiKey))?.value).toBe('legacy-key')
    expect(existsSync(work.filePath)).toBe(true)
    expect(readFileSync(join(dir, 'credentials.enc')).equals(before)).toBe(true)

    // Later writes go to the machine file only
    await work.set(apiKey, { value: 'updated' })
    expect(readFileSync(join(dir, 'credentials.enc')).equals(before)).toBe(true)
    expect((await backend(WORK).get(apiKey))?.value).toBe('updated')
  })

  it('leaves another machine\'s legacy file alone and starts empty', async () => {
    const before = await writeLegacyFile(WORK, 'work-only')

    const home = backend(HOME)
    expect(await home.get(apiKey)).toBeNull()
    expect(readFileSync(join(dir, 'credentials.enc')).equals(before)).toBe(true)

    await home.set(apiKey, { value: 'home-key' })
    expect(readFileSync(join(dir, 'credentials.enc')).equals(before)).toBe(true)
    expect((await backend(HOME).get(apiKey))?.value).toBe('home-key')
  })

  it('quarantines an unreadable own file instead of deleting it', async () => {
    const work = backend(WORK)
    writeFileSync(work.filePath, Buffer.from('not a credentials file'))

    expect(await work.get(apiKey)).toBeNull()
    const files = readdirSync(dir)
    expect(files).not.toContain(getMachineCredentialsFilename(WORK))
    expect(files.some(f => f.startsWith(`${getMachineCredentialsFilename(WORK)}.unreadable-`))).toBe(true)

    // Recovers: new credentials can be stored
    await work.set(apiKey, { value: 'fresh' })
    expect((await backend(WORK).get(apiKey))?.value).toBe('fresh')
  })
})
