import { describe, expect, it } from 'vitest'
import raw from '../../../tests/fixtures/manual-v1.json?raw'
import { importSchemeJson } from '../../domain/import'
import { useEditorDraftState } from '../useEditorDraftState'
import { useProjectHistory } from '../useProjectHistory'
import { useProjectDocument } from '../useProjectDocument'

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
