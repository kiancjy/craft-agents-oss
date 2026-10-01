import { beforeEach, describe, expect, it } from 'bun:test'
import { createStore } from 'jotai'
import type { ArtifactRef } from '@craft-agent/ui'
import {
  ARTIFACT_PANE_MAX_ARTIFACTS,
  artifactPaneAtomFamily,
  bumpArtifactVersionAtom,
  closeArtifactPaneAtom,
  openArtifactAtom,
  registerArtifactAtom,
  setActiveArtifactAtom,
} from '../artifact-pane'

class MemoryStorage {
  private map = new Map<string, string>()
  getItem(key: string) { return this.map.get(key) ?? null }
  setItem(key: string, value: string) { this.map.set(key, value) }
  removeItem(key: string) { this.map.delete(key) }
  clear() { this.map.clear() }
  key(index: number) { return Array.from(this.map.keys())[index] ?? null }
  get length() { return this.map.size }
}

function ref(key: string, code = `code-${key}`): ArtifactRef {
  return { key, type: 'html-preview', title: `Title ${key}`, code }
}

function resetFamilies() {
  for (const param of Array.from(artifactPaneAtomFamily.getParams())) artifactPaneAtomFamily.remove(param)
}

beforeEach(() => {
  ;(globalThis as { localStorage?: unknown }).localStorage = new MemoryStorage()
  resetFamilies()
})

describe('artifact pane atoms', () => {
  it('starts closed with no artifacts', () => {
    const store = createStore()
    expect(store.get(artifactPaneAtomFamily('s1'))).toEqual({ open: false, activeKey: null, order: [], artifacts: {} })
  })

  it('registering an artifact lists it without opening the pane', () => {
    const store = createStore()
    store.set(registerArtifactAtom, { sessionId: 's1', ref: ref('a') })
    const state = store.get(artifactPaneAtomFamily('s1'))
    expect(state.open).toBe(false)
    expect(state.order).toEqual(['a'])
    expect(state.artifacts.a?.version).toBe(1)
  })

  it('opening an artifact registers it, activates it and opens the pane', () => {
    const store = createStore()
    store.set(openArtifactAtom, { sessionId: 's1', ref: ref('a') })
    const state = store.get(artifactPaneAtomFamily('s1'))
    expect(state.open).toBe(true)
    expect(state.activeKey).toBe('a')
    expect(state.order).toEqual(['a'])
  })

  it('opening a second artifact replaces the active one and keeps both listed', () => {
    const store = createStore()
    store.set(openArtifactAtom, { sessionId: 's1', ref: ref('a') })
    store.set(openArtifactAtom, { sessionId: 's1', ref: ref('b') })
    const state = store.get(artifactPaneAtomFamily('s1'))
    expect(state.activeKey).toBe('b')
    expect(state.order).toEqual(['a', 'b'])
  })

  it('re-registering the same key with new code bumps the version, same code does not', () => {
    const store = createStore()
    store.set(registerArtifactAtom, { sessionId: 's1', ref: ref('a', 'v1') })
    store.set(registerArtifactAtom, { sessionId: 's1', ref: ref('a', 'v1') })
    expect(store.get(artifactPaneAtomFamily('s1')).artifacts.a?.version).toBe(1)
    store.set(registerArtifactAtom, { sessionId: 's1', ref: ref('a', 'v2') })
    const state = store.get(artifactPaneAtomFamily('s1'))
    expect(state.artifacts.a?.version).toBe(2)
    expect(state.artifacts.a?.code).toBe('v2')
    expect(state.order).toEqual(['a'])
  })

  it('bumping a version marks a file change without touching other artifacts', () => {
    const store = createStore()
    store.set(registerArtifactAtom, { sessionId: 's1', ref: ref('a') })
    store.set(registerArtifactAtom, { sessionId: 's1', ref: ref('b') })
    store.set(bumpArtifactVersionAtom, { sessionId: 's1', key: 'a' })
    const state = store.get(artifactPaneAtomFamily('s1'))
    expect(state.artifacts.a?.version).toBe(2)
    expect(state.artifacts.b?.version).toBe(1)
  })

  it('closing keeps the artifacts and the active key so reopening restores the view', () => {
    const store = createStore()
    store.set(openArtifactAtom, { sessionId: 's1', ref: ref('a') })
    store.set(closeArtifactPaneAtom, { sessionId: 's1' })
    const state = store.get(artifactPaneAtomFamily('s1'))
    expect(state.open).toBe(false)
    expect(state.activeKey).toBe('a')
    expect(state.order).toEqual(['a'])
  })

  it('switching to a listed artifact opens the pane on it and ignores unknown keys', () => {
    const store = createStore()
    store.set(registerArtifactAtom, { sessionId: 's1', ref: ref('a') })
    store.set(setActiveArtifactAtom, { sessionId: 's1', key: 'a' })
    expect(store.get(artifactPaneAtomFamily('s1')).open).toBe(true)
    expect(store.get(artifactPaneAtomFamily('s1')).activeKey).toBe('a')
    store.set(setActiveArtifactAtom, { sessionId: 's1', key: 'missing' })
    expect(store.get(artifactPaneAtomFamily('s1')).activeKey).toBe('a')
  })

  it('keeps sessions isolated', () => {
    const store = createStore()
    store.set(openArtifactAtom, { sessionId: 's1', ref: ref('a') })
    expect(store.get(artifactPaneAtomFamily('s2'))).toEqual({ open: false, activeKey: null, order: [], artifacts: {} })
  })

  it('drops the oldest artifacts beyond the cap', () => {
    const store = createStore()
    for (let i = 0; i < ARTIFACT_PANE_MAX_ARTIFACTS + 3; i += 1) {
      store.set(registerArtifactAtom, { sessionId: 's1', ref: ref(`k${i}`) })
    }
    const state = store.get(artifactPaneAtomFamily('s1'))
    expect(state.order).toHaveLength(ARTIFACT_PANE_MAX_ARTIFACTS)
    expect(state.order[0]).toBe('k3')
    expect(state.artifacts.k0).toBeUndefined()
  })

  it('persists pane state per session and restores it in a fresh store', () => {
    const store = createStore()
    store.set(openArtifactAtom, { sessionId: 's1', ref: ref('a') })
    resetFamilies()
    const fresh = createStore()
    const restored = fresh.get(artifactPaneAtomFamily('s1'))
    expect(restored.open).toBe(true)
    expect(restored.activeKey).toBe('a')
    expect(restored.artifacts.a?.title).toBe('Title a')
    expect(fresh.get(artifactPaneAtomFamily('s2')).order).toEqual([])
  })
})
