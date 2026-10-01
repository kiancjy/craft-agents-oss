import { atom } from 'jotai'
import { atomFamily } from 'jotai-family'
import type { ArtifactRef } from '@craft-agent/ui'
import * as storage from '@/lib/local-storage'

export const ARTIFACT_PANE_MAX_ARTIFACTS = 50

export interface StoredArtifact extends ArtifactRef {
  version: number
}

export interface ArtifactPaneState {
  open: boolean
  activeKey: string | null
  order: string[]
  artifacts: Record<string, StoredArtifact>
}

const EMPTY_STATE: ArtifactPaneState = { open: false, activeKey: null, order: [], artifacts: {} }

function readState(sessionId: string): ArtifactPaneState {
  const saved = storage.get<Partial<ArtifactPaneState> | null>(storage.KEYS.artifactPane, null, sessionId)
  if (!saved || typeof saved !== 'object') return EMPTY_STATE
  const artifacts = saved.artifacts && typeof saved.artifacts === 'object' ? saved.artifacts : {}
  const order = Array.isArray(saved.order) ? saved.order.filter((key) => key in artifacts) : []
  const activeKey = typeof saved.activeKey === 'string' && saved.activeKey in artifacts ? saved.activeKey : null
  return { open: !!saved.open && activeKey !== null, activeKey, order, artifacts }
}

export const artifactPaneAtomFamily = atomFamily((sessionId: string) => {
  const base = atom<ArtifactPaneState>(readState(sessionId))
  return atom(
    (get) => get(base),
    (_get, set, next: ArtifactPaneState) => {
      set(base, next)
      storage.set(storage.KEYS.artifactPane, next, sessionId)
    },
  )
})

function upsert(state: ArtifactPaneState, ref: ArtifactRef): ArtifactPaneState {
  const existing = state.artifacts[ref.key]
  if (existing) {
    if (existing.code === ref.code && existing.title === ref.title) return state
    const version = existing.code === ref.code ? existing.version : existing.version + 1
    return { ...state, artifacts: { ...state.artifacts, [ref.key]: { ...ref, version } } }
  }
  const order = [...state.order, ref.key]
  const artifacts = { ...state.artifacts, [ref.key]: { ...ref, version: 1 } }
  while (order.length > ARTIFACT_PANE_MAX_ARTIFACTS) {
    const dropped = order.shift()
    if (dropped && dropped !== state.activeKey) delete artifacts[dropped]
    else if (dropped) order.push(dropped)
  }
  return { ...state, order, artifacts }
}

export const registerArtifactAtom = atom(null, (get, set, { sessionId, ref }: { sessionId: string; ref: ArtifactRef }) => {
  const paneAtom = artifactPaneAtomFamily(sessionId)
  const current = get(paneAtom)
  const next = upsert(current, ref)
  if (next !== current) set(paneAtom, next)
})

export const openArtifactAtom = atom(null, (get, set, { sessionId, ref }: { sessionId: string; ref: ArtifactRef }) => {
  const paneAtom = artifactPaneAtomFamily(sessionId)
  const next = upsert(get(paneAtom), ref)
  set(paneAtom, { ...next, open: true, activeKey: ref.key })
})

export const setActiveArtifactAtom = atom(null, (get, set, { sessionId, key }: { sessionId: string; key: string }) => {
  const paneAtom = artifactPaneAtomFamily(sessionId)
  const current = get(paneAtom)
  if (!current.artifacts[key]) return
  set(paneAtom, { ...current, open: true, activeKey: key })
})

export const closeArtifactPaneAtom = atom(null, (get, set, { sessionId }: { sessionId: string }) => {
  const paneAtom = artifactPaneAtomFamily(sessionId)
  const current = get(paneAtom)
  if (!current.open) return
  set(paneAtom, { ...current, open: false })
})

export const bumpArtifactVersionAtom = atom(null, (get, set, { sessionId, key }: { sessionId: string; key: string }) => {
  const paneAtom = artifactPaneAtomFamily(sessionId)
  const current = get(paneAtom)
  const existing = current.artifacts[key]
  if (!existing) return
  set(paneAtom, { ...current, artifacts: { ...current.artifacts, [key]: { ...existing, version: existing.version + 1 } } })
})

