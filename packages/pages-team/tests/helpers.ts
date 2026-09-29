import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const OWNER = 'kian@getincredible.com'
export const DOMAIN = 'getincredible.com'

/** A temporary workspace with one page per entry. */
export function makeWorkspace(pages: Array<{ slug: string; name?: string; kind?: string; html?: string; snapshot?: unknown }>): string {
  const root = mkdtempSync(join(tmpdir(), 'pages-team-'))
  for (const page of pages) {
    const folder = join(root, 'pages', page.slug)
    mkdirSync(join(folder, 'data'), { recursive: true })
    writeFileSync(
      join(folder, 'page.json'),
      JSON.stringify({
        schemaVersion: 1,
        id: `page_${page.slug}`,
        slug: page.slug,
        name: page.name ?? page.slug,
        kind: page.kind ?? 'interactive',
        createdAt: 1,
        updatedAt: 2,
        contentDigest: 'a'.repeat(64),
      }),
    )
    writeFileSync(join(folder, 'index.html'), page.html ?? `<h1>${page.slug}</h1>`)
    if (page.snapshot !== undefined) writeFileSync(join(folder, 'data', 'snapshot.json'), JSON.stringify(page.snapshot))
  }
  return root
}
