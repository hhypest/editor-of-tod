import { ref, shallowRef } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import raw from '../../../tests/fixtures/manual-v1.json?raw'
import { importSchemeJson } from '../../domain/import'
import { startHistory } from '../../domain/edit-history'
import type { RevisionEditor } from '../useProjectRevisionActions'
import { useProjectPersistence, type ProjectPersistenceRepository } from '../useProjectPersistence'

afterEach(() => vi.unstubAllGlobals())

function harness() {
  const imported = shallowRef(importSchemeJson(raw))
  const editor: RevisionEditor = {
    imported,
    history: shallowRef(startHistory(imported.value.scheme)),
    localRevision: ref(3),
    localBusy: ref(false),
    loading: ref(false),
    editorDirty: ref(false),
    hasUnsavedWork: ref(false),
    modifiedSinceLocalSave: ref(false),
    selectedFileName: ref('учебный.json'),
    localError: ref(''),
    localNotice: ref(''),
    projectsRefreshKey: ref(0),
    cursor: () => ({ session: 1, edit: 1 }),
    recoveryId: () => 'recovery',
    beginSession: vi.fn(),
    openProjectRecord: vi.fn(),
    flushRecovery: vi.fn(async () => true),
    clearRecovery: vi.fn(async () => undefined),
    showLocalError: vi.fn(),
  }
  const record = {
    scheme: imported.value.scheme,
    revision: 7,
    updatedAt: '2030-01-01T00:00:00Z',
    storedSchemaVersion: 9,
  }
  const repository: ProjectPersistenceRepository = {
    get: vi.fn(async () => record),
    save: vi.fn(),
    restore: vi.fn(),
  }
  vi.stubGlobal('window', { confirm: vi.fn(() => true) })
  return { editor, repository, record, persistence: useProjectPersistence(editor, repository) }
}

describe('local project read boundary', () => {
  it('opens a validated record through the existing document callback with its stored format', async () => {
    const { editor, repository, record, persistence } = harness()
    await persistence.openLocal(record.scheme.id)
    expect(repository.get).toHaveBeenCalledWith(record.scheme.id)
    expect(editor.openProjectRecord).toHaveBeenCalledWith(record.scheme, 7, 9)
    expect(editor.localBusy.value).toBe(false)
  })

  it.each(['busy', 'loading', 'cancel', 'recovery-failed'])(
    'does not read or replace a document when %s',
    async (condition) => {
      const { editor, repository, persistence } = harness()
      if (condition === 'busy') editor.localBusy.value = true
      if (condition === 'loading') editor.loading.value = true
      if (condition === 'cancel' || condition === 'recovery-failed') {
        // The public context deliberately exposes this as readonly to the adapter.
        const unsaved = ref(true)
        editor.hasUnsavedWork = unsaved
        if (condition === 'cancel') vi.mocked(window.confirm).mockReturnValue(false)
        else vi.mocked(editor.flushRecovery).mockResolvedValue(false)
      }
      const before = editor.imported.value
      const history = editor.history.value
      await persistence.openLocal('next')
      expect(repository.get).not.toHaveBeenCalled()
      expect(editor.openProjectRecord).not.toHaveBeenCalled()
      expect(editor.imported.value).toBe(before)
      expect(editor.history.value).toBe(history)
    },
  )

  it('preserves the open document and history on failure and unlocks the operation', async () => {
    const { editor, repository, persistence } = harness()
    const failure = new Error('Учебная ошибка чтения')
    vi.mocked(repository.get).mockRejectedValue(failure)
    const before = editor.imported.value
    const history = editor.history.value
    await persistence.openLocal('next')
    expect(editor.imported.value).toBe(before)
    expect(editor.history.value).toBe(history)
    expect(editor.localRevision.value).toBe(3)
    expect(editor.showLocalError).toHaveBeenCalledWith(failure)
    expect(editor.localBusy.value).toBe(false)
  })
})
