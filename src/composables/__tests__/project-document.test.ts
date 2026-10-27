import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from 'vue'
import { createPinia, setActivePinia, storeToRefs } from 'pinia'
import { useProjectDocumentStore } from '../../stores/project-document'
import raw from '../../../tests/fixtures/manual-v1.json?raw'
import { importSchemeJson } from '../../domain/import'
import { createSchemeDetailsDraft } from '../../domain/edit-details'
import { createPlacementDraft } from '../../domain/edit-placements'
import { useEditorDraftState } from '../useEditorDraftState'
import { useProjectHistory } from '../useProjectHistory'
import { useProjectDocument } from '../useProjectDocument'

beforeEach(() => setActivePinia(createPinia()))
afterEach(() => {
  setActivePinia(undefined)
  vi.restoreAllMocks()
})

function document() {
  const drafts = useEditorDraftState()
  const edits = useProjectHistory()
  const model = useProjectDocument(drafts, edits)
  const result = importSchemeJson(raw)
  const scheme = {
    ...result.scheme,
    signImages: {
      catalog: { id: 1, documentCode: 'Учебный', edition: '2030' },
      revisions: { '1.25': 2 },
    },
  }
  model.openDocument({
    result: { ...result, scheme },
    fileName: 'учебный.json',
    revision: 5,
    modified: false,
    selectedPlacementId: scheme.placements[0]?.id ?? null,
  })
  return { model, drafts, edits, scheme, result }
}

describe('in-memory project document boundary', () => {
  it('starts empty and ignores commit/undo/redo without an open document', () => {
    const drafts = useEditorDraftState()
    const edits = useProjectHistory()
    const model = useProjectDocument(drafts, edits)
    expect(model.imported.value).toBeNull()
    expect(edits.history.value).toBeNull()
    expect(model.selectedFileName.value).toBe('')
    expect(model.errorMessage.value).toBe('')
    expect(model.loading.value).toBe(false)
    expect(model.modifiedSinceLocalSave.value).toBe(false)
    expect(model.localRevision.value).toBeNull()
    expect(model.selectedPlacementId.value).toBeNull()
    expect(drafts.editorDirty.value).toBe(false)
    model.commitScheme(importSchemeJson(raw).scheme)
    expect(model.stepHistory('back')).toBe(false)
    expect(model.stepHistory('forward')).toBe(false)
    expect(model.imported.value).toBeNull()
    expect(edits.history.value).toBeNull()
  })

  it('separates clearing dirty flags from clearing pending input and the recovery seed', () => {
    const { model, drafts, edits, scheme } = document()
    const details = createSchemeDetailsDraft(scheme)
    const placement = createPlacementDraft(scheme.placements[0]!)
    const seed = { details, placement }
    drafts.pendingDetails.value = details
    drafts.pendingPlacement.value = placement
    drafts.recoverySeed.value = seed
    drafts.detailsDirty.value = true
    drafts.placementDirty.value = true
    const history = edits.history.value
    drafts.clearDirty()
    expect(drafts.editorDirty.value).toBe(false)
    expect(drafts.pendingDetails.value).toBe(details)
    expect(drafts.pendingPlacement.value).toBe(placement)
    expect(drafts.recoverySeed.value).toBe(seed)
    drafts.detailsDirty.value = true
    drafts.placementDirty.value = true
    drafts.clearPending()
    expect(drafts.pendingDetails.value).toBeNull()
    expect(drafts.pendingPlacement.value).toBeNull()
    expect(drafts.recoverySeed.value).toBeNull()
    expect(drafts.detailsDirty.value).toBe(true)
    expect(drafts.placementDirty.value).toBe(true)
    expect(model.imported.value!.scheme).toBe(scheme)
    expect(edits.history.value).toBe(history)
  })

  it('opens and clears the document without discarding pending input or changing the loading flag', () => {
    const { model, drafts, edits, scheme, result } = document()
    const details = createSchemeDetailsDraft(scheme)
    const seed = { details, placement: null }
    drafts.pendingDetails.value = details
    drafts.recoverySeed.value = seed
    drafts.detailsDirty.value = true
    model.loading.value = true
    model.errorMessage.value = 'Учебный отказ'
    const next = { ...scheme, id: crypto.randomUUID() }
    model.openDocument({
      result: { ...result, scheme: next },
      fileName: 'новый-учебный.json',
      revision: 7,
      modified: true,
      selectedPlacementId: next.placements[0]?.id ?? null,
    })
    expect(model.imported.value!.scheme).toBe(next)
    expect(edits.history.value).toEqual({ past: [], present: next, future: [] })
    expect(model.loading.value).toBe(true)
    expect(model.errorMessage.value).toBe('Учебный отказ')
    expect(model.localRevision.value).toBe(7)
    expect(model.modifiedSinceLocalSave.value).toBe(true)
    expect(drafts.editorDirty.value).toBe(false)
    expect(drafts.pendingDetails.value).toBe(details)
    expect(drafts.recoverySeed.value).toBe(seed)
    model.clearDocument('следующий.json')
    expect(model.imported.value).toBeNull()
    expect(edits.history.value).toBeNull()
    expect(model.selectedPlacementId.value).toBeNull()
    expect(model.localRevision.value).toBeNull()
    expect(model.modifiedSinceLocalSave.value).toBe(false)
    expect(model.errorMessage.value).toBe('')
    expect(model.loading.value).toBe(true)
    expect(model.selectedFileName.value).toBe('следующий.json')
    expect(drafts.pendingDetails.value).toBe(details)
    expect(drafts.recoverySeed.value).toBe(seed)
  })

  it('blocks both history directions for dirty forms without altering pending input or snapshots', () => {
    const { model, drafts, edits, scheme } = document()
    const changed = {
      ...scheme,
      parameters: { ...scheme.parameters, locationText: 'Учебная правка' },
    }
    model.commitScheme(changed)
    const applied = model.imported.value!.scheme
    const details = createSchemeDetailsDraft(applied)
    drafts.pendingDetails.value = details
    drafts.detailsDirty.value = true
    const history = edits.history.value
    expect(model.stepHistory('back')).toBe(false)
    expect(model.stepHistory('forward')).toBe(false)
    expect(model.imported.value!.scheme).toBe(applied)
    expect(edits.history.value).toBe(history)
    drafts.clearDirty()
    expect(model.stepHistory('back')).toBe(true)
    expect(model.imported.value!.scheme).toBe(scheme)
    drafts.placementDirty.value = true
    const undone = edits.history.value
    expect(model.stepHistory('forward')).toBe(false)
    expect(edits.history.value).toBe(undone)
    drafts.clearDirty()
    expect(model.stepHistory('forward')).toBe(true)
    expect(model.imported.value!.scheme).toBe(applied)
    expect(drafts.pendingDetails.value).toBe(details)
  })

  it('keeps pin invalidation and one undo step in the applied edit, restoring original pins on undo', () => {
    const { model, drafts, edits, scheme } = document()
    drafts.detailsDirty.value = true
    model.commitScheme({ ...scheme, placements: [] })
    expect(model.imported.value!.scheme.signImages).toEqual({ catalog: null, revisions: {} })
    expect(edits.history.value!.past).toEqual([scheme])
    expect(drafts.editorDirty.value).toBe(false)
    expect(model.localRevision.value).toBe(5)
    expect(model.modifiedSinceLocalSave.value).toBe(true)

    drafts.placementDirty.value = true
    expect(model.stepHistory('back')).toBe(false)
    expect(model.imported.value!.scheme.placements).toEqual([])
    drafts.placementDirty.value = false
    expect(model.stepHistory('back')).toBe(true)
    expect(model.imported.value!.scheme).toBe(scheme)
    expect(model.imported.value!.scheme.signImages.revisions).toEqual({ '1.25': 2 })
    expect(model.stepHistory('forward')).toBe(true)
    expect(model.imported.value!.scheme.signImages.catalog).toBeNull()
    expect(edits.history.value!.past).toHaveLength(1)
  })

  it('opens another document with its own metadata and a fresh history', () => {
    const { model, drafts, edits, scheme, result } = document()
    model.commitScheme({ ...scheme, placements: [] })
    drafts.detailsDirty.value = true
    model.clearDocument('следующий.json')
    expect(model.imported.value).toBeNull()
    expect(edits.history.value).toBeNull()
    expect(model.localRevision.value).toBeNull()
    expect(drafts.editorDirty.value).toBe(false)

    const next = { ...result.scheme, id: crypto.randomUUID() }
    model.openDocument({
      result: { ...result, scheme: next },
      fileName: 'следующий.json',
      revision: 9,
      modified: false,
      selectedPlacementId: null,
    })
    expect(model.imported.value!.scheme).toBe(next)
    expect(model.selectedPlacementId.value).toBeNull()
    expect(model.localRevision.value).toBe(9)
    expect(model.selectedFileName.value).toBe('следующий.json')
    expect(model.modifiedSinceLocalSave.value).toBe(false)
    expect(edits.history.value).toEqual({ past: [], present: next, future: [] })
    expect(model.stepHistory('back')).toBe(false)
  })
})

function readDocument() {
  const drafts = useEditorDraftState()
  const edits = useProjectHistory()
  const model = useProjectDocument(drafts, edits)
  return { drafts, edits, model }
}

describe('app-scoped project document ownership (#191)', () => {
  it('shares a live document, metadata, one history and pending input between consumers without resetting them', () => {
    const app = createApp({ render: () => null }).use(createPinia())
    const first = app.runWithContext(() => document())
    const details = createSchemeDetailsDraft(first.scheme)
    first.drafts.pendingDetails.value = details
    first.drafts.detailsDirty.value = true
    const history = first.edits.history.value
    const second = app.runWithContext(() => readDocument())
    expect(second.model.imported.value).toBe(first.model.imported.value)
    expect(second.edits.history.value).toBe(history)
    expect(second.drafts.pendingDetails.value).toBe(details)
    expect(second.drafts.editorDirty.value).toBe(true)
    expect(second.model.localRevision.value).toBe(5)
    expect(second.model.selectedFileName.value).toBe('учебный.json')
    second.model.selectedPlacementId.value = null
    expect(first.model.selectedPlacementId.value).toBeNull()
    second.model.commitScheme({ ...first.scheme, placements: [] })
    expect(first.model.imported.value!.scheme.signImages).toEqual({ catalog: null, revisions: {} })
    expect(first.edits.history.value!.past).toEqual([first.scheme])
    expect(first.drafts.editorDirty.value).toBe(false)
    expect(first.model.stepHistory('back')).toBe(true)
    expect(second.model.imported.value!.scheme).toBe(first.scheme)
    expect(second.model.stepHistory('forward')).toBe(true)
    expect(first.model.imported.value!.scheme.placements).toEqual([])
    expect(first.edits.history.value!.past).toHaveLength(1)
    expect(first.drafts.pendingDetails.value).toBe(details)
    expect(second.drafts.pendingDetails.value).toBe(details)
  })

  it('isolates document/history/input/errors between apps and keeps commands bound after an active-app switch', async () => {
    const firstPinia = createPinia()
    const firstApp = createApp({ render: () => null }).use(firstPinia)
    const first = firstApp.runWithContext(() => document())
    const secondPinia = createPinia()
    const secondApp = createApp({ render: () => null }).use(secondPinia)
    const second = secondApp.runWithContext(() => document())
    const secondScheme = { ...second.scheme, id: first.scheme.id }
    second.model.openDocument({
      result: { ...second.result, scheme: secondScheme },
      fileName: 'второе-окно.json',
      revision: 9,
      modified: false,
      selectedPlacementId: null,
    })
    const secondDocument = second.model.imported.value
    const secondHistory = second.edits.history.value
    const details = createSchemeDetailsDraft(first.scheme)
    first.drafts.pendingDetails.value = details
    first.drafts.recoverySeed.value = { details, placement: null }
    first.model.errorMessage.value = 'Учебный отказ первого окна'
    first.model.loading.value = true
    first.model.localRevision.value = 11
    await Promise.resolve()
    setActivePinia(secondPinia)
    first.model.commitScheme({ ...first.scheme, placements: [] })
    expect(first.edits.history.value!.past).toEqual([first.scheme])
    expect(first.model.localRevision.value).toBe(11)
    expect(second.model.imported.value).toBe(secondDocument)
    expect(second.edits.history.value).toBe(secondHistory)
    expect(second.drafts.pendingDetails.value).toBeNull()
    expect(second.drafts.recoverySeed.value).toBeNull()
    expect(second.model.errorMessage.value).toBe('')
    expect(second.model.loading.value).toBe(false)
    expect(second.model.localRevision.value).toBe(9)
    first.model.clearDocument('очищено-первое.json')
    expect(first.model.imported.value).toBeNull()
    expect(first.drafts.pendingDetails.value).toBe(details)
    expect(second.model.imported.value).toBe(secondDocument)
    expect(second.edits.history.value).toBe(secondHistory)
  })

  it('assembles adapters from explicitly captured refs without HTTP, timers or an implicit active-store lookup', () => {
    const fetch = vi.spyOn(globalThis, 'fetch')
    const timer = vi.spyOn(globalThis, 'setInterval')
    const firstPinia = createPinia()
    const state = storeToRefs(useProjectDocumentStore(firstPinia))
    const secondPinia = createPinia()
    setActivePinia(secondPinia)
    const drafts = useEditorDraftState(state)
    const edits = useProjectHistory(state)
    const model = useProjectDocument(drafts, edits, state)
    const result = importSchemeJson(raw)
    model.openDocument({
      result,
      fileName: 'явный-владелец.json',
      revision: 3,
      modified: false,
      selectedPlacementId: null,
    })
    expect(state.imported.value).toBe(result)
    const other = useProjectDocumentStore(secondPinia)
    expect(other.imported).toBeNull()
    expect(other.history).toBeNull()
    expect(other.pendingDetails).toBeNull()
    expect(fetch).not.toHaveBeenCalled()
    expect(timer).not.toHaveBeenCalled()
  })
})
