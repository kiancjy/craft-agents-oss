export type ArtifactType =
  | 'html-preview'
  | 'markdown-preview'
  | 'pdf-preview'
  | 'image-preview'
  | 'mermaid'
  | 'datatable'
  | 'spreadsheet'

export interface ArtifactRef {
  key: string
  type: ArtifactType
  title: string
  code: string
}

export type BlockPresentation = 'inline' | 'pane'

interface ParsedSpec {
  src: string | null
  title: string | null
}

function parseSpec(code: string): ParsedSpec {
  try {
    const parsed = JSON.parse(code) as unknown
    if (!parsed || typeof parsed !== 'object') return { src: null, title: null }
    const record = parsed as Record<string, unknown>
    const title = typeof record.title === 'string' && record.title.trim() ? record.title.trim() : null
    if (typeof record.src === 'string' && record.src) return { src: record.src, title }
    const items = Array.isArray(record.items) ? record.items : []
    const first = items[0] as Record<string, unknown> | undefined
    if (first && typeof first.src === 'string' && first.src) return { src: first.src, title }
    return { src: null, title }
  } catch {
    return { src: null, title: null }
  }
}

function contentHash(input: string): string {
  let hash = 2166136261
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

function fileName(src: string): string {
  const segments = src.split(/[\\/]/)
  return segments[segments.length - 1] || src
}

export function createArtifactRef(type: ArtifactType, code: string): ArtifactRef {
  const spec = parseSpec(code)
  const key = spec.src ? `${type}:${spec.src}` : `${type}:${contentHash(code)}`
  const title = spec.title ?? (spec.src ? fileName(spec.src) : type)
  return { key, type, title, code }
}

export function resolveArtifactSrc(ref: ArtifactRef): string | null {
  return parseSpec(ref.code).src
}
