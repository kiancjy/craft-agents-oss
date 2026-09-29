/**
 * Read-only access to page files.
 *
 * The team server reads exactly three files for each page: page.json,
 * index.html, and data/snapshot.json. It never writes them. The slug must
 * match the same pattern the app uses (/^[a-z0-9-]+$/), so no request can
 * name a path outside {workspaceRoot}/pages/{slug}/.
 *
 * This module deliberately does not import @craft-agent/shared: that package
 * also holds the credential and source code, and the team server must not
 * load it.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

export const PAGE_SLUG_REGEX = /^[a-z0-9-]+$/
const MAX_SLUG_CHARS = 128

export type PageKind = 'static' | 'interactive' | 'live'

export interface PageInfo {
  slug: string
  name: string
  description?: string
  kind: PageKind
  contentDigest?: string
  updatedAt: number
  folder: string
}

export function isValidSlug(slug: unknown): slug is string {
  return typeof slug === 'string' && slug.length > 0 && slug.length <= MAX_SLUG_CHARS && PAGE_SLUG_REGEX.test(slug)
}

export class PageFiles {
  constructor(readonly workspaceRoot: string) {}

  get pagesDir(): string {
    return join(this.workspaceRoot, 'pages')
  }

  folder(slug: string): string {
    if (!isValidSlug(slug)) throw new Error(`Invalid page slug: ${String(slug)}`)
    return join(this.pagesDir, slug)
  }

  /** The page config, or null when the page does not exist (or was deleted). */
  load(slug: string): PageInfo | null {
    if (!isValidSlug(slug)) return null
    const folder = this.folder(slug)
    const configPath = join(folder, 'page.json')
    if (!existsSync(configPath)) return null
    try {
      const raw = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>
      if (raw.slug !== slug || typeof raw.name !== 'string') return null
      const kind = raw.kind === 'static' || raw.kind === 'live' ? raw.kind : 'interactive'
      return {
        slug,
        name: raw.name,
        description: typeof raw.description === 'string' ? raw.description : undefined,
        kind,
        contentDigest: typeof raw.contentDigest === 'string' ? raw.contentDigest : undefined,
        updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : 0,
        folder,
      }
    } catch {
      return null
    }
  }

  list(): PageInfo[] {
    if (!existsSync(this.pagesDir)) return []
    return readdirSync(this.pagesDir)
      .filter(isValidSlug)
      .map(slug => this.load(slug))
      .filter((p): p is PageInfo => p !== null)
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  content(slug: string): string | null {
    const path = join(this.folder(slug), 'index.html')
    if (!existsSync(path)) return null
    return readFileSync(path, 'utf-8')
  }

  /** The data snapshot as raw JSON text (passed through untouched), or null. */
  snapshotText(slug: string): string | null {
    const path = join(this.folder(slug), 'data', 'snapshot.json')
    if (!existsSync(path)) return null
    return readFileSync(path, 'utf-8')
  }

  /** A cheap change marker for the snapshot, so browsers fetch it only on change. */
  snapshotVersion(slug: string): string | null {
    const path = join(this.folder(slug), 'data', 'snapshot.json')
    if (!existsSync(path)) return null
    const st = statSync(path)
    return createHash('sha256').update(`${st.mtimeMs}:${st.size}`).digest('hex').slice(0, 16)
  }
}
