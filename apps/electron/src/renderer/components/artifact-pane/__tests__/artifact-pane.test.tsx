import { beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Provider, createStore } from 'jotai'

mock.module('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '' }))
mock.module('pdfjs-dist', () => ({ GlobalWorkerOptions: { workerSrc: '' }, getDocument: () => ({}) }))

class MemoryStorage {
  private map = new Map<string, string>()
  getItem(key: string) { return this.map.get(key) ?? null }
  setItem(key: string, value: string) { this.map.set(key, value) }
  removeItem(key: string) { this.map.delete(key) }
  clear() { this.map.clear() }
  key(index: number) { return Array.from(this.map.keys())[index] ?? null }
  get length() { return this.map.size }
}

type PaneModule = typeof import('../ArtifactPane')
type AtomsModule = typeof import('@/atoms/artifact-pane')
type UiModule = typeof import('@craft-agent/ui')
let pane: PaneModule
let atoms: AtomsModule
let ui: UiModule

beforeAll(async () => {
  ;(globalThis as { localStorage?: unknown }).localStorage = new MemoryStorage()
  ui = await import('@craft-agent/ui')
  pane = await import('../ArtifactPane')
  atoms = await import('@/atoms/artifact-pane')
})

beforeEach(() => {
  ;(globalThis as { localStorage?: unknown }).localStorage = new MemoryStorage()
  for (const param of Array.from(atoms.artifactPaneAtomFamily.getParams())) atoms.artifactPaneAtomFamily.remove(param)
})

function render(store: ReturnType<typeof createStore>, sessionId: string) {
  return renderToStaticMarkup(
    <Provider store={store}>
      <ui.TooltipProvider>
        <pane.ArtifactPane sessionId={sessionId} />
      </ui.TooltipProvider>
    </Provider>,
  )
}

describe('ArtifactPane', () => {
  it('renders nothing when no artifact is active', () => {
    const store = createStore()
    expect(render(store, 's1')).toBe('')
  })

  it('renders the active artifact title and content', () => {
    const store = createStore()
    const ref = { key: 'mermaid:abc', type: 'mermaid' as const, title: 'Flow', code: 'graph LR\nA-->B' }
    store.set(atoms.openArtifactAtom, { sessionId: 's1', ref })
    const markup = render(store, 's1')
    expect(markup).toContain('data-artifact-pane="mermaid:abc"')
    expect(markup).toContain('Flow')
    expect(markup).toContain('data-artifact-close')
    expect(markup).not.toContain('data-artifact-open')
    expect(markup).not.toContain('lucide-maximize-2')
  })

  it('renders no notes affordances', () => {
    const store = createStore()
    const ref = { key: 'mermaid:abc', type: 'mermaid' as const, title: 'Flow', code: 'graph LR\nA-->B' }
    store.set(atoms.openArtifactAtom, { sessionId: 's1', ref })
    const markup = render(store, 's1')
    expect(markup).not.toContain('data-artifact-notes')
    expect(markup).not.toContain('data-artifact-send-notes')
    expect(markup).not.toContain('<textarea')
  })

  it('does not render an artifact opened in a different session', () => {
    const store = createStore()
    const ref = { key: 'datatable:abc', type: 'datatable' as const, title: 'Rows', code: '{"columns":[{"key":"a","label":"A"}],"rows":[{"a":1}]}' }
    store.set(atoms.openArtifactAtom, { sessionId: 's2', ref })
    expect(render(store, 's1')).toBe('')
  })
})
