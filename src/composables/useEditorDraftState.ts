import { storeToRefs } from 'pinia'
import { useProjectDocumentStore, type ProjectDocumentRefs } from '../stores/project-document'

type DraftState = Pick<
  ProjectDocumentRefs,
  | 'detailsDirty'
  | 'placementDirty'
  | 'roadNodeDirty'
  | 'pendingDetails'
  | 'pendingPlacement'
  | 'pendingRoadNode'
  | 'recoverySeed'
  | 'editorDirty'
>

/** Unapplied form input is distinct from a modified, applied document. */
export function useEditorDraftState(state: DraftState = storeToRefs(useProjectDocumentStore())) {
  const {
    detailsDirty,
    placementDirty,
    roadNodeDirty,
    pendingDetails,
    pendingPlacement,
    pendingRoadNode,
    recoverySeed,
    editorDirty,
  } = state

  function clearDirty(): void {
    detailsDirty.value = false
    placementDirty.value = false
    roadNodeDirty.value = false
  }

  function clearPending(): void {
    recoverySeed.value = null
    pendingDetails.value = null
    pendingPlacement.value = null
    pendingRoadNode.value = null
  }

  return {
    detailsDirty,
    placementDirty,
    roadNodeDirty,
    pendingDetails,
    pendingPlacement,
    pendingRoadNode,
    recoverySeed,
    editorDirty,
    clearDirty,
    clearPending,
  }
}

export type EditorDraftState = ReturnType<typeof useEditorDraftState>
