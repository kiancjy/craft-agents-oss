/**
 * Secure Storage Backend
 *
 * Stores credentials in an encrypted file at ~/.craft-agent/credentials.<machine>.enc
 * Uses AES-256-GCM for authenticated encryption.
 *
 * The file is per-machine: <machine> is a short hash of the hardware UUID. Users
 * often sync ~/.craft-agent across Macs (e.g. via iCloud Drive), and since the
 * key is machine-bound, a single shared file could only ever be read by one of
 * them — the other would treat it as corrupt and delete it, wiping both. Each
 * machine now reads and writes only its own file. The legacy shared
 * `credentials.enc` is imported once if this machine can decrypt it, and is
 * never modified or deleted.
 *
 * Encryption key is derived from OS-native hardware UUID using PBKDF2:
 * - macOS: IOPlatformUUID (tied to logic board, never changes)
 * - Windows: MachineGuid from registry (set at OS install)
 * - Linux: /var/lib/dbus/machine-id (set at OS install)
 *
 * This is more stable than the previous hostname-based derivation, which could
 * change with network/DHCP. Legacy credentials are auto-migrated on first load.
 *
 * File format:
 *   [Header - 64 bytes]
 *   ├── Magic: "CRAFT01\0" (8 bytes)
 *   ├── Flags: uint32 LE (4 bytes) - reserved for future use
 *   ├── Salt: 32 bytes (PBKDF2 salt)
 *   ├── Reserved: 20 bytes
 *   [Encrypted Payload]
 *   ├── IV: 12 bytes (random per write)
 *   ├── Auth Tag: 16 bytes (GCM authentication)
 *   └── Ciphertext: variable (encrypted JSON)
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  pbkdf2Sync,
  createHash,
} from 'crypto';
import { execSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'fs';
import { hostname, userInfo, homedir } from 'os';
import { join, dirname } from 'path';

import type { CredentialBackend } from './types.ts';
import type { CredentialId, StoredCredential } from '../types.ts';
import { credentialIdToAccount, accountToCredentialId } from '../types.ts';

// File location
const DEFAULT_CREDENTIALS_DIR = join(homedir(), '.craft-agent');
/** Pre-per-machine filename, shared by every machine syncing the config dir. */
const LEGACY_CREDENTIALS_FILENAME = 'credentials.enc';

// File format constants
const MAGIC_BYTES = Buffer.from('CRAFT01\0');
const HEADER_SIZE = 64;
const MAGIC_SIZE = 8;
const FLAGS_SIZE = 4;
const SALT_SIZE = 32;
const IV_SIZE = 12;
const AUTH_TAG_SIZE = 16;
const KEY_SIZE = 32;

// PBKDF2 iterations (balance security vs startup time)
const PBKDF2_ITERATIONS = 100000;

/**
 * Get stable machine identifier using OS-native hardware UUID.
 * This is far more stable than hostname which can change with network/DHCP.
 * Falls back to username + homedir if hardware UUID unavailable.
 */
let cachedMachineId: string | null = null;

function getStableMachineId(): string {
  if (cachedMachineId === null) cachedMachineId = readStableMachineId();
  return cachedMachineId;
}

function readStableMachineId(): string {
  try {
    if (process.platform === 'darwin') {
      // macOS: IOPlatformUUID - tied to logic board, never changes
      const output = execSync(
        'ioreg -rd1 -c IOPlatformExpertDevice | grep IOPlatformUUID',
        { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
      );
      const match = output.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
      if (match?.[1]) return match[1];
    } else if (process.platform === 'win32') {
      // Windows: MachineGuid from registry - set at OS install
      const output = execSync(
        'reg query HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography /v MachineGuid',
        { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
      );
      const match = output.match(/MachineGuid\s+REG_SZ\s+(\S+)/);
      if (match?.[1]) return match[1];
    } else {
      // Linux: dbus machine-id - set at OS install
      const machineIdPath = '/var/lib/dbus/machine-id';
      const altPath = '/etc/machine-id';
      if (existsSync(machineIdPath)) {
        return readFileSync(machineIdPath, 'utf-8').trim();
      } else if (existsSync(altPath)) {
        return readFileSync(altPath, 'utf-8').trim();
      }
    }
  } catch {
    // Fall through to fallback
  }

  // Fallback: username + homedir (stable enough for most cases)
  return `${userInfo().username}:${homedir()}`;
}

/**
 * Per-machine credentials filename. Hashed so the raw hardware UUID never
 * appears in a (possibly cloud-synced) directory listing.
 */
export function getMachineCredentialsFilename(machineId: string = getStableMachineId()): string {
  const hash = createHash('sha256')
    .update(machineId)
    .update('craft-agent-credentials-file')
    .digest('hex')
    .slice(0, 12);
  return `credentials.${hash}.enc`;
}

/** All credential filenames this machine owns (per-machine + legacy), for logout. */
export function getCredentialsFilenames(): string[] {
  return [getMachineCredentialsFilename(), LEGACY_CREDENTIALS_FILENAME];
}

export interface SecureStorageOptions {
  /** Directory holding credential files. Defaults to ~/.craft-agent. */
  dir?: string;
  /** Override the hardware machine ID (tests). */
  machineId?: string;
}

type ReadResult =
  | { status: 'ok'; store: CredentialStore; salt: Buffer; usedLegacyKey: boolean }
  | { status: 'io-error' }
  | { status: 'unreadable' };

/** Internal credential store structure */
interface CredentialStore {
  version: 1;
  credentials: Record<string, StoredCredential>;
  metadata: {
    createdAt: number;
    updatedAt: number;
  };
}

export class SecureStorageBackend implements CredentialBackend {
  readonly name = 'secure-storage';
  readonly priority = 100;

  private cachedStore: CredentialStore | null = null;
  private encryptionKey: Buffer | null = null;
  /** Salt the cached encryptionKey was derived with. */
  private keySalt: Buffer | null = null;
  private salt: Buffer | null = null;

  private readonly dir: string;
  private readonly machineIdOverride: string | undefined;
  private resolvedFile: string | null = null;

  constructor(options: SecureStorageOptions = {}) {
    this.dir = options.dir ?? DEFAULT_CREDENTIALS_DIR;
    this.machineIdOverride = options.machineId;
  }

  private get machineId(): string {
    return this.machineIdOverride ?? getStableMachineId();
  }

  /** This machine's credentials file (resolved lazily — hardware ID lookup shells out). */
  get filePath(): string {
    if (!this.resolvedFile) {
      this.resolvedFile = join(this.dir, getMachineCredentialsFilename(this.machineId));
    }
    return this.resolvedFile;
  }

  private get legacyFilePath(): string {
    return join(this.dir, LEGACY_CREDENTIALS_FILENAME);
  }

  async isAvailable(): Promise<boolean> {
    // File backend is always available - we can always write to filesystem
    return true;
  }

  async get(id: CredentialId): Promise<StoredCredential | null> {
    const store = await this.loadStore();
    if (!store) return null;

    const key = credentialIdToAccount(id);
    return store.credentials[key] || null;
  }

  async set(id: CredentialId, credential: StoredCredential): Promise<void> {
    let store = await this.loadStore();

    if (!store) {
      // Initialize new store
      store = {
        version: 1,
        credentials: {},
        metadata: {
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      };
    }

    const key = credentialIdToAccount(id);
    store.credentials[key] = credential;
    store.metadata.updatedAt = Date.now();

    await this.saveStore(store);
  }

  async delete(id: CredentialId): Promise<boolean> {
    return this.deleteSync(id);
  }

  deleteSync(id: CredentialId): boolean {
    const store = this.loadStoreSync();
    if (!store) return false;

    const key = credentialIdToAccount(id);
    if (!(key in store.credentials)) return false;

    delete store.credentials[key];
    store.metadata.updatedAt = Date.now();

    this.saveStoreSync(store);
    return true;
  }

  async list(filter?: Partial<CredentialId>): Promise<CredentialId[]> {
    const store = await this.loadStore();
    if (!store) return [];

    const ids = Object.keys(store.credentials)
      .map(accountToCredentialId)
      .filter((id): id is CredentialId => id !== null);

    if (!filter) return ids;

    return ids.filter((id) => {
      if (filter.type && id.type !== filter.type) return false;
      if (filter.workspaceId && id.workspaceId !== filter.workspaceId) return false;
      if (filter.name && id.name !== filter.name) return false;
      return true;
    });
  }

  // ============================================================
  // Private Methods
  // ============================================================

  private async loadStore(): Promise<CredentialStore | null> {
    return this.loadStoreSync();
  }

  private loadStoreSync(): CredentialStore | null {
    // Return cached store if available
    if (this.cachedStore) return this.cachedStore;

    if (!existsSync(this.filePath)) return this.importLegacyStore();

    const result = this.readStoreFile(this.filePath);
    if (result.status === 'io-error') return null;
    if (result.status === 'unreadable') {
      this.quarantineUnreadableFile();
      return null;
    }

    this.salt = result.salt;
    this.cachedStore = result.store;
    if (result.usedLegacyKey) {
      // Migration: re-save with new stable key so future loads use hardware UUID
      this.saveStoreSync(result.store);
    }
    return result.store;
  }

  /**
   * One-time import of the legacy shared `credentials.enc`, if this machine can
   * decrypt it. If it can't (it belongs to another machine syncing the same
   * dir), it's left untouched and we start empty. Never modifies the legacy file.
   */
  private importLegacyStore(): CredentialStore | null {
    if (!existsSync(this.legacyFilePath)) return null;

    const result = this.readStoreFile(this.legacyFilePath);
    if (result.status !== 'ok') return null;

    this.salt = result.salt;
    this.saveStoreSync(result.store);
    return result.store;
  }

  /** Read and decrypt a credentials file with the current key, then the v1 legacy key. */
  private readStoreFile(path: string): ReadResult {
    let fileData: Buffer;
    try {
      fileData = readFileSync(path);
    } catch {
      return { status: 'io-error' };
    }

    // Validate minimum size and magic bytes
    if (fileData.length < HEADER_SIZE + IV_SIZE + AUTH_TAG_SIZE) return { status: 'unreadable' };
    if (!fileData.subarray(0, MAGIC_SIZE).equals(MAGIC_BYTES)) return { status: 'unreadable' };

    // Parse header
    // const flags = fileData.readUInt32LE(MAGIC_SIZE); // Reserved for future use
    const salt = Buffer.from(fileData.subarray(MAGIC_SIZE + FLAGS_SIZE, MAGIC_SIZE + FLAGS_SIZE + SALT_SIZE));

    // Extract encrypted data
    const encryptedData = fileData.subarray(HEADER_SIZE);

    // Try new stable key first (v2 - hardware UUID based)
    const store = this.tryDecrypt(encryptedData, this.getEncryptionKey(salt));
    if (store) return { status: 'ok', store, salt, usedLegacyKey: false };

    // Try legacy key for migration (v1 - included hostname)
    const legacyStore = this.tryDecrypt(encryptedData, this.getLegacyEncryptionKey(salt));
    if (legacyStore) return { status: 'ok', store: legacyStore, salt, usedLegacyKey: true };

    return { status: 'unreadable' };
  }

  /**
   * Attempt to decrypt data with given key.
   * Returns parsed store on success, null on failure.
   */
  private tryDecrypt(encryptedData: Buffer, key: Buffer): CredentialStore | null {
    try {
      const iv = encryptedData.subarray(0, IV_SIZE);
      const authTag = encryptedData.subarray(IV_SIZE, IV_SIZE + AUTH_TAG_SIZE);
      const ciphertext = encryptedData.subarray(IV_SIZE + AUTH_TAG_SIZE);

      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(authTag);
      const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      return JSON.parse(decrypted.toString('utf8'));
    } catch {
      return null;
    }
  }

  private async saveStore(store: CredentialStore): Promise<void> {
    this.saveStoreSync(store);
  }

  private saveStoreSync(store: CredentialStore): void {
    // Ensure directory exists
    if (!existsSync(this.dir)) {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    }

    // Use existing salt or generate new one
    const salt = this.salt || randomBytes(SALT_SIZE);
    this.salt = salt;

    // Get encryption key
    const key = this.getEncryptionKey(salt);

    // Serialize payload
    const plaintext = Buffer.from(JSON.stringify(store), 'utf8');

    // Generate new IV for each write (critical for GCM security)
    const iv = randomBytes(IV_SIZE);

    // Encrypt
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const authTag = cipher.getAuthTag();

    // Build header
    const header = Buffer.alloc(HEADER_SIZE);
    MAGIC_BYTES.copy(header, 0);
    header.writeUInt32LE(0, MAGIC_SIZE); // Flags (reserved)
    salt.copy(header, MAGIC_SIZE + FLAGS_SIZE);

    // Combine all parts
    const fileData = Buffer.concat([header, iv, authTag, ciphertext]);

    // Write with restrictive permissions (owner read/write only)
    writeFileSync(this.filePath, fileData, { mode: 0o600 });
    this.cachedStore = store;
  }

  private getEncryptionKey(salt: Buffer): Buffer {
    if (this.encryptionKey && this.keySalt?.equals(salt)) return this.encryptionKey;

    // New stable machine ID using hardware UUID (v2)
    // This is far more stable than hostname which can change with network/DHCP
    const stableMachineId = createHash('sha256')
      .update(this.machineId)
      .update('craft-agent-v2') // Bumped version for new key derivation
      .digest();

    // Derive key using PBKDF2
    this.encryptionKey = pbkdf2Sync(stableMachineId, salt, PBKDF2_ITERATIONS, KEY_SIZE, 'sha256');
    this.keySalt = salt;

    return this.encryptionKey;
  }

  /**
   * Legacy key derivation for migration from v1 (included hostname).
   * Used to decrypt credentials from older versions before re-encrypting with stable key.
   */
  private getLegacyEncryptionKey(salt: Buffer): Buffer {
    const legacyMachineId = createHash('sha256')
      .update(hostname())
      .update(userInfo().username)
      .update(homedir())
      .update('craft-agent-v1')
      .digest();

    return pbkdf2Sync(legacyMachineId, salt, PBKDF2_ITERATIONS, KEY_SIZE, 'sha256');
  }

  /**
   * This machine's own file can't be decrypted. Move it aside rather than
   * deleting it, so nothing is lost silently; the user re-enters credentials.
   */
  private quarantineUnreadableFile(): void {
    try {
      if (existsSync(this.filePath)) {
        renameSync(this.filePath, `${this.filePath}.unreadable-${Date.now()}`);
      }
    } catch {
      // Ignore rename errors
    }
    this.clearCache();
  }

  /** Clear cached data (for testing or forced refresh) */
  clearCache(): void {
    this.cachedStore = null;
    this.encryptionKey = null;
    this.keySalt = null;
    this.salt = null;
  }
}
