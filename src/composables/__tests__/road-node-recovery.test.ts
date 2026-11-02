import { ref } from 'vue'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import raw from '../../../tests/fixtures/frozen/projects/project-v12-native-b34.json?raw'
import { importSchemeJson } from '../../domain/import'
import { createRoadNodeDraft } from '../../domain/edit-road-nodes'
import { useEditorDraftState } from '../useEditorDraftState'
import { useProjectHistory } from '../useProjectHistory'
import { useProjectDocument } from '../useProjectDocument'
import { useRecoveryActions } from '../useRecoveryActions'

beforeEach(() => setActivePinia(createPinia()))
afterEach(() => {
  setActivePinia(undefined)
  vi.unstubAllGlobals()
})

it('restores the road form in its own ID namespace without selecting a same-numbered placement', async () => {
  vi.stubGlobal('window', { confirm: vi.fn(() => true) })
  const scheme = importSchemeJson(raw).scheme
  const road = createRoadNodeDraft(scheme.roadLayout.nodes[1]!)
  road.metres = '-'
  road.name = 'Неприменённая правка'
  const record = {
    sessionId: crypto.randomUUID(),
    scheme,
    baseRevision: 5,
    detailsDraft: null,
    placementDraft: road,
    fileName: 'учебное-примыкание.json',
    version: 2,
    updatedAt: '2026-11-01T08:00:00.000Z',
  }
  const drafts = useEditorDraftState(),
    edits = useProjectHistory()
  const document = useProjectDocument(drafts, edits)
  const showError = vi.fn()
  const actions = useRecoveryActions(
    {
      projectDocument: document,
      drafts,
      loading: ref(false),
      localBusy: ref(false),
      localError: ref(''),
      localNotice: ref(''),
      hasUnsavedWork: ref(false),
      beginSession: vi.fn(),
      onProjectOpened: vi.fn(),
      showLocalError: showError,
    },
    {
      recoveryCopies: ref([
        {
          sessionId: record.sessionId,
          version: 2,
          baseRevision: 5,
          updatedAt: record.updatedAt,
          fileName: record.fileName,
          referenceId: 'Учебный',
          active: false,
        },
      ]),
      activeRecoveryId: ref('current'),
      claim: vi.fn(async () => record),
      flush: vi.fn(async () => true),
      remove: vi.fn(),
      refresh: vi.fn(),
    },
  )
  await actions.openRecovery(record.sessionId)
  expect(showError).not.toHaveBeenCalled()
  expect(document.imported.value?.format).toBe('scheme-v14')
  expect(document.selectedPlacementId.value).toBe(scheme.placements[0]!.id)
  expect(document.selectedRoadNodeId.value).toBe(road.id)
  expect(drafts.pendingPlacement.value).toBeNull()
  expect(drafts.pendingRoadNode.value).toEqual(road)
  expect(drafts.recoverySeed.value).toEqual({ details: null, placement: null, roadNode: road })
  expect(document.imported.value?.scheme).toEqual(scheme)
  drafts.roadNodeDirty.value = true
  expect(drafts.editorDirty.value).toBe(true)
  drafts.clearDirty()
  expect(drafts.editorDirty.value).toBe(false)
  drafts.clearPending()
  expect(drafts.pendingRoadNode.value).toBeNull()
  document.clearDocument('')
  expect(document.selectedRoadNodeId.value).toBeNull()
})
