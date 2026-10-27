import { defineStore, type storeToRefs } from 'pinia'
import { computed, ref, shallowRef } from 'vue'
import type { ImportResult } from '../domain/import'
import type { Scheme } from '../domain/model'
import type { EditHistory } from '../domain/edit-history'
import type { SchemeDetailsDraft } from '../domain/edit-details'
import type { PlacementDraft } from '../domain/edit-placements'

/** One document/history/recoverable input per app; commands and lifecycle stay in adapters. */
export const useProjectDocumentStore = defineStore('projectDocument', () => {
  const imported = shallowRef<ImportResult | null>(null)
  const selectedFileName = ref('')
  const errorMessage = ref('')
  const loading = ref(false)
  const modifiedSinceLocalSave = ref(false)
  const localRevision = ref<number | null>(null)
  const selectedPlacementId = ref<number | null>(null)
  const history = shallowRef<EditHistory<Scheme> | null>(null)
  const detailsDirty = ref(false)
  const placementDirty = ref(false)
  const pendingDetails = shallowRef<SchemeDetailsDraft | null>(null)
  const pendingPlacement = shallowRef<PlacementDraft | null>(null)
  const recoverySeed = shallowRef<{
    details: SchemeDetailsDraft | null
    placement: PlacementDraft | null
  } | null>(null)
  const editorDirty = computed(() => detailsDirty.value || placementDirty.value)

  return {
    imported,
    selectedFileName,
    errorMessage,
    loading,
    modifiedSinceLocalSave,
    localRevision,
    selectedPlacementId,
    history,
    detailsDirty,
    placementDirty,
    pendingDetails,
    pendingPlacement,
    recoverySeed,
    editorDirty,
  }
})

export type ProjectDocumentRefs = ReturnType<
  typeof storeToRefs<ReturnType<typeof useProjectDocumentStore>>
>
