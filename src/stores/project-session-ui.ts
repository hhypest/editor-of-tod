import { defineStore, type storeToRefs } from 'pinia'
import { ref } from 'vue'
import type { RecoverySummary } from '../domain/recovery'

/** Shared session feedback only; workflows, recovery ownership and lifecycle stay in adapters. */
export const useProjectSessionUiStore = defineStore('projectSessionUi', () => {
  const localBusy = ref(false)
  const localError = ref('')
  const localNotice = ref('')
  const projectsRefreshKey = ref(0)
  const templateMessage = ref('')
  const templateError = ref('')
  const signPinMessage = ref('')
  const recoveryCopies = ref<RecoverySummary[]>([])
  const recoveryStatus = ref<'idle' | 'pending' | 'saving' | 'saved' | 'error'>('idle')
  // Assigned by the one recovery adapter, never by a reader of the projection.
  const activeRecoveryId = ref('')

  return {
    localBusy,
    localError,
    localNotice,
    projectsRefreshKey,
    templateMessage,
    templateError,
    signPinMessage,
    recoveryCopies,
    recoveryStatus,
    activeRecoveryId,
  }
})

export type ProjectSessionUiRefs = ReturnType<
  typeof storeToRefs<ReturnType<typeof useProjectSessionUiStore>>
>
