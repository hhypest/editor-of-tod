import { computed, ref, shallowRef } from 'vue'
import type { SchemeDetailsDraft } from '../domain/edit-details'
import type { PlacementDraft } from '../domain/edit-placements'

/** Unapplied form input is distinct from a modified, applied document. */
export function useEditorDraftState() {
  const detailsDirty = ref(false)
  const placementDirty = ref(false)
  const pendingDetails = shallowRef<SchemeDetailsDraft | null>(null)
  const pendingPlacement = shallowRef<PlacementDraft | null>(null)
  const recoverySeed = shallowRef<{
    details: SchemeDetailsDraft | null
    placement: PlacementDraft | null
  } | null>(null)
  const editorDirty = computed(() => detailsDirty.value || placementDirty.value)

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
