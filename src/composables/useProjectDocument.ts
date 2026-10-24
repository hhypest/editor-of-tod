import { ref, shallowRef } from 'vue'
import type { ImportResult } from '../domain/import'
import type { Scheme } from '../domain/model'
import { clearPinsAfterSignChange } from '../domain/sign-images'
import type { EditorDraftState } from './useEditorDraftState'
import type { ProjectHistory } from './useProjectHistory'

export interface OpenProjectDocument {
  result: ImportResult
  fileName: string
  revision: number | null
  modified: boolean
  selectedPlacementId: number | null
}

/** Coordinates the in-memory document and history; no HTTP, timers or browser lifecycle. */
export function useProjectDocument(drafts: EditorDraftState, edits: ProjectHistory) {
  const imported = shallowRef<ImportResult | null>(null)
  const selectedFileName = ref('')
  const errorMessage = ref('')
  const loading = ref(false)
  const modifiedSinceLocalSave = ref(false)
  const localRevision = ref<number | null>(null)
  const selectedPlacementId = ref<number | null>(null)

  function clearDocument(fileName: string): void {
    imported.value = null
    edits.reset()
    selectedPlacementId.value = null
    drafts.clearDirty()
    modifiedSinceLocalSave.value = false
    localRevision.value = null
    errorMessage.value = ''
    selectedFileName.value = fileName
  }

  function openDocument(input: OpenProjectDocument): void {
    imported.value = input.result
    edits.start(input.result.scheme)
    selectedPlacementId.value = input.selectedPlacementId
    selectedFileName.value = input.fileName
    localRevision.value = input.revision
    drafts.clearDirty()
    modifiedSinceLocalSave.value = input.modified
  }

  function commitScheme(scheme: Scheme): void {
    if (!imported.value) return
    scheme = clearPinsAfterSignChange(imported.value.scheme, scheme)
    edits.record(imported.value.scheme, scheme)
    imported.value = { ...imported.value, scheme }
    drafts.clearDirty()
    modifiedSinceLocalSave.value = true
  }

  function stepHistory(direction: 'back' | 'forward'): boolean {
    if (!imported.value || drafts.editorDirty.value) return false
    const scheme = edits.step(direction)
    if (!scheme) return false
    // History snapshots already include their own PNG pins; never recompute them on undo/redo.
    imported.value = { ...imported.value, scheme }
    modifiedSinceLocalSave.value = true
    return true
  }

  return {
    imported,
    selectedFileName,
    errorMessage,
    loading,
    modifiedSinceLocalSave,
    localRevision,
    selectedPlacementId,
    clearDocument,
    openDocument,
    commitScheme,
    stepHistory,
  }
}
