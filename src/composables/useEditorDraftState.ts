import { storeToRefs } from 'pinia'
import { useProjectDocumentStore, type ProjectDocumentRefs } from '../stores/project-document'

type DraftState = Pick<
  ProjectDocumentRefs,
  | 'detailsDirty'
  | 'placementDirty'
  | 'pendingDetails'
  | 'pendingPlacement'
  | 'recoverySeed'
  | 'editorDirty'
>

/** Unapplied form input is distinct from a modified, applied document. */
export function useEditorDraftState(state: DraftState = storeToRefs(useProjectDocumentStore())) {
  const {
    detailsDirty,
    placementDirty,
    pendingDetails,
    pendingPlacement,
    recoverySeed,
    editorDirty,
  } = state

  function clearDirty(): void {
    detailsDirty.value = false
    placementDirty.value = false
  }

  function clearPending(): void {
    recoverySeed.value = null
    pendingDetails.value = null
    pendingPlacement.value = null
  }

  return {
    detailsDirty,
    placementDirty,
    pendingDetails,
    pendingPlacement,
    recoverySeed,
    editorDirty,
    clearDirty,
    clearPending,
  }
}

export type EditorDraftState = ReturnType<typeof useEditorDraftState>
