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
  for (const param of Array.from(atoms.artifactNotesAtomFamily.getParams())) atoms.artifactNotesAtomFamily.remove(param)
})

function render(store: ReturnType<typeof createStore>, sessionId: string) {
  return renderToStaticMarkup(
    <Provider store={store}>
      <ui.TooltipProvider>
        <pane.ArtifactPane sessionId={sessionId} onSendToChat={() => {}} />
      </ui.TooltipProvider>
    </Provider>,
  )
}

describe('ArtifactPane', () => {
  it('renders nothing when no artifact is active', () => {
    const store = createStore()
    expect(render(store, 's1')).toBe('')
  })

  it('renders the active artifact title, content and stored notes', () => {
    const store = createStore()
    const ref = { key: 'mermaid:abc', type: 'mermaid' as const, title: 'Flow', code: 'graph LR\nA-->B' }
    store.set(atoms.openArtifactAtom, { sessionId: 's1', ref })
    store.set(atoms.artifactNotesAtomFamily({ sessionId: 's1', key: ref.key }), 'remember this')
    const markup = render(store, 's1')
    expect(markup).toContain('data-artifact-pane="mermaid:abc"')
    expect(markup).toContain('Flow')
    expect(markup).toContain('remember this')
    expect(markup).toContain('data-artifact-close')
    expect(markup).not.toContain('data-artifact-open')
    expect(markup).not.toContain('lucide-maximize-2')
  })

  it('does not render notes from a different session', () => {
    const store = createStore()
    const ref = { key: 'datatable:abc', type: 'datatable' as const, title: 'Rows', code: '{"columns":[{"key":"a","label":"A"}],"rows":[{"a":1}]}' }
    store.set(atoms.openArtifactAtom, { sessionId: 's1', ref })
    store.set(atoms.artifactNotesAtomFamily({ sessionId: 's2', key: ref.key }), 'other session')
    expect(render(store, 's1')).not.toContain('other session')
  })
})

describe('notes helpers', () => {
  it('appends a heading reference on a fresh line', () => {
    expect(pane.appendHeadingReference('', 'Scope')).toBe('## Scope\n- ')
    expect(pane.appendHeadingReference('first', 'Scope')).toBe('first\n\n## Scope\n- ')
    expect(pane.appendHeadingReference('first\n', 'Scope')).toBe('first\n\n## Scope\n- ')
  })

  it('builds the chat message with a bold heading and trimmed notes', () => {
    expect(pane.buildNotesMessage('Notes on Flow', '  a\nb  ')).toBe('**Notes on Flow**\n\na\nb')
  })
})
