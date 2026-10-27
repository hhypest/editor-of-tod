import { ref } from 'vue'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import raw from '../../../tests/fixtures/manual-v1.json?raw'
import { importSchemeJson } from '../../domain/import'
import { createSchemeDetailsDraft } from '../../domain/edit-details'
import { createPlacementDraft } from '../../domain/edit-placements'
import { useEditorDraftState } from '../useEditorDraftState'
import { useProjectHistory } from '../useProjectHistory'
import { useProjectDocument } from '../useProjectDocument'
import { useRecoveryActions } from '../useRecoveryActions'

beforeEach(() => setActivePinia(createPinia()))
afterEach(() => {
  setActivePinia(undefined)
  vi.unstubAllGlobals()
})

it('opens a claimed copy and hydrates its unapplied form input after opening the document view', async () => {
  vi.stubGlobal('window', { confirm: vi.fn(() => true) })
  const scheme = importSchemeJson(raw).scheme
  const detailsDraft = { ...createSchemeDetailsDraft(scheme), locationText: 'Неприменённый ввод' }
  const placementDraft = createPlacementDraft(scheme.placements[0]!)
  const record = {
    sessionId: crypto.randomUUID(),
    scheme,
    baseRevision: 4,
    detailsDraft,
    placementDraft,
    fileName: 'учебная-копия.json',
    version: 3,
    updatedAt: '2030-01-01T00:00:00Z',
  }
  const { scheme: _scheme, detailsDraft: _details, placementDraft: _placement, ...summary } = record
  void _scheme
  void _details
  void _placement
  const drafts = useEditorDraftState()
  const history = useProjectHistory()
  const projectDocument = useProjectDocument(drafts, history)
  const localBusy = ref(false)
  const localNotice = ref('')
  const onProjectOpened = vi.fn(() => {
    expect(projectDocument.imported.value!.scheme).toBe(scheme)
    expect(drafts.recoverySeed.value).toBeNull()
  })
  const beginSession = vi.fn()
  const claim = vi.fn(async () => record)
  const actions = useRecoveryActions(
    {
      projectDocument,
      drafts,
      loading: ref(false),
      localBusy,
      localError: ref(''),
      localNotice,
      hasUnsavedWork: ref(false),
      beginSession,
      onProjectOpened,
      showLocalError: vi.fn(),
    },
    {
      recoveryCopies: ref([{ ...summary, referenceId: 'Учебный', active: false }]),
      activeRecoveryId: ref('current'),
      flush: vi.fn(async () => true),
      claim,
      remove: vi.fn(),
      refresh: vi.fn(),
    },
  )
  await actions.openRecovery(record.sessionId)
  expect(claim).toHaveBeenCalledWith(record.sessionId, 3)
  expect(beginSession).toHaveBeenCalledWith(record.sessionId)
  expect(onProjectOpened).toHaveBeenCalledTimes(1)
  expect(projectDocument.localRevision.value).toBe(4)
  expect(projectDocument.modifiedSinceLocalSave.value).toBe(true)
  expect(drafts.pendingDetails.value).toBe(detailsDraft)
  expect(drafts.pendingPlacement.value).toBe(placementDraft)
  expect(drafts.recoverySeed.value).toEqual({ details: detailsDraft, placement: placementDraft })
  expect(localBusy.value).toBe(false)
  expect(localNotice.value).toContain('Рабочая копия восстановлена')
})
