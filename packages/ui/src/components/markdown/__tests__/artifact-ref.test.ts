import { describe, expect, it } from 'bun:test'
import { createArtifactRef, resolveArtifactSrc } from '../artifact-ref'

describe('createArtifactRef', () => {
  it('keys file-backed artifacts by type and src so re-renders map to the same artifact', () => {
    const first = createArtifactRef('html-preview', '{"src":"/tmp/a.html","title":"A"}')
    const second = createArtifactRef('html-preview', '{"title":"A renamed","src":"/tmp/a.html"}')
    expect(first.key).toBe('html-preview:/tmp/a.html')
    expect(second.key).toBe(first.key)
  })

  it('uses the first item src for multi-item artifacts', () => {
    const ref = createArtifactRef('markdown-preview', '{"items":[{"src":"/tmp/v1.md"},{"src":"/tmp/v2.md"}]}')
    expect(ref.key).toBe('markdown-preview:/tmp/v1.md')
  })

  it('keys inline artifacts by content hash so edited content becomes a new artifact', () => {
    const a = createArtifactRef('mermaid', 'graph LR\nA-->B')
    const b = createArtifactRef('mermaid', 'graph LR\nA-->C')
    const again = createArtifactRef('mermaid', 'graph LR\nA-->B')
    expect(a.key).not.toBe(b.key)
    expect(a.key).toBe(again.key)
    expect(a.key.startsWith('mermaid:')).toBe(true)
  })

  it('keeps file-backed keys distinct across artifact types', () => {
    const html = createArtifactRef('html-preview', '{"src":"/tmp/same"}')
    const md = createArtifactRef('markdown-preview', '{"src":"/tmp/same"}')
    expect(html.key).not.toBe(md.key)
  })

  it('takes the title from the spec and falls back to the file name', () => {
    expect(createArtifactRef('pdf-preview', '{"src":"/tmp/report.pdf","title":"Q1"}').title).toBe('Q1')
    expect(createArtifactRef('pdf-preview', '{"src":"/tmp/report.pdf"}').title).toBe('report.pdf')
    expect(createArtifactRef('datatable', '{"title":"Sales","columns":[],"rows":[]}').title).toBe('Sales')
  })

  it('falls back to the type for untitled inline artifacts', () => {
    expect(createArtifactRef('mermaid', 'graph LR\nA-->B').title).toBe('mermaid')
    expect(createArtifactRef('datatable', 'not json').title).toBe('datatable')
  })

  it('carries the raw code so the pane can re-render the block', () => {
    const ref = createArtifactRef('spreadsheet', '{"columns":[],"rows":[]}')
    expect(ref.code).toBe('{"columns":[],"rows":[]}')
    expect(ref.type).toBe('spreadsheet')
  })
})

describe('resolveArtifactSrc', () => {
  it('returns the src for file-backed artifacts and null for inline ones', () => {
    expect(resolveArtifactSrc(createArtifactRef('image-preview', '{"src":"/tmp/a.png"}'))).toBe('/tmp/a.png')
    expect(resolveArtifactSrc(createArtifactRef('datatable', '{"src":"/tmp/rows.json","columns":[]}'))).toBe('/tmp/rows.json')
    expect(resolveArtifactSrc(createArtifactRef('mermaid', 'graph LR\nA-->B'))).toBeNull()
    expect(resolveArtifactSrc(createArtifactRef('datatable', '{"columns":[],"rows":[]}'))).toBeNull()
  })
})
