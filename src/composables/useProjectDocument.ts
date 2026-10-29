import { storeToRefs } from 'pinia'
import type { ImportResult } from '../domain/import'
import type { Scheme } from '../domain/model'
import { clearPinsAfterSignChange } from '../domain/sign-images'
import type { EditorDraftState } from './useEditorDraftState'
import type { ProjectHistory } from './useProjectHistory'
import { useProjectDocumentStore, type ProjectDocumentRefs } from '../stores/project-document'
import { useProjectSessionUiStore, type ProjectSessionUiRefs } from '../stores/project-session-ui'

const PIN_RESET_MESSAGE =
  'Закрепление версий PNG снято. Лист использует текущие изображения каталога. На этапе «Знаки и объекты» нажмите «Закрепить версии PNG», затем заново проверьте знаки перед выпуском.'

type DocumentState = Pick<
  ProjectDocumentRefs,
  | 'imported'
  | 'selectedFileName'
  | 'errorMessage'
  | 'loading'
  | 'modifiedSinceLocalSave'
  | 'localRevision'
  | 'selectedPlacementId'
>

export interface OpenProjectDocument {
  result: ImportResult
  fileName: string
  revision: number | null
  modified: boolean
  selectedPlacementId: number | null
}

/** Coordinates the in-memory document and history; no HTTP, timers or browser lifecycle. */
export function useProjectDocument(
  drafts: EditorDraftState,
  edits: ProjectHistory,
  state: DocumentState = storeToRefs(useProjectDocumentStore()),
  feedback: Pick<ProjectSessionUiRefs, 'signPinMessage'> = storeToRefs(useProjectSessionUiStore()),
) {
  const { signPinMessage } = feedback
  const {
    imported,
    selectedFileName,
    errorMessage,
    loading,
    modifiedSinceLocalSave,
    localRevision,
    selectedPlacementId,
  } = state

  function clearDocument(fileName: string): void {
    signPinMessage.value = ''
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
    signPinMessage.value = ''
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
    const previous = imported.value.scheme
    scheme = clearPinsAfterSignChange(imported.value.scheme, scheme)
    updatePinMessage(previous, scheme)
    edits.record(imported.value.scheme, scheme)
    imported.value = { ...imported.value, scheme }
    drafts.clearDirty()
    modifiedSinceLocalSave.value = true
  }

  function stepHistory(direction: 'back' | 'forward'): boolean {
    if (!imported.value || drafts.editorDirty.value) return false
    const scheme = edits.step(direction)
    if (!scheme) return false
    updatePinMessage(imported.value.scheme, scheme)
    // History snapshots already include their own PNG pins; never recompute them on undo/redo.
    imported.value = { ...imported.value, scheme }
    modifiedSinceLocalSave.value = true
    return true
  }

  function updatePinMessage(previous: Scheme, next: Scheme): void {
    if (previous.signImages.catalog && !next.signImages.catalog)
      signPinMessage.value = PIN_RESET_MESSAGE
    else if (next.signImages.catalog) signPinMessage.value = ''
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
