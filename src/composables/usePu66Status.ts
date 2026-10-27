import { storeToRefs, type Pinia } from 'pinia'
import { computed, onMounted, onUnmounted, watch, type Ref } from 'vue'
import { pu66StatusFinding } from '../domain/pu66-lifecycle'
import { usePu66StatusStore } from '../stores/pu66-status'

/** Capture in setup so asynchronous handlers keep the originating app's store. */
export function usePu66StatusInvalidation(): () => void {
  return usePu66StatusStore().invalidate
}

/** Compatible contextual call; outside setup pass the intended Pinia explicitly. */
export function invalidatePu66Status(pinia?: Pinia): void {
  usePu66StatusStore(pinia).invalidate()
}

export function usePu66Status(key: Ref<string>) {
  const store = usePu66StatusStore()
  const { states, version } = storeToRefs(store)
  const status = computed(() => states.value[key.value]?.status ?? null)
  const unavailable = computed(() => states.value[key.value]?.unavailable ?? false)
  const loading = computed(() => states.value[key.value]?.loading ?? false)
  const reload = () => store.reloadKey(key.value)
  watch([key, version], () => void reload(), { immediate: true })
  const onFocus = () => void reload()
  onMounted(() => window.addEventListener('focus', onFocus))
  onUnmounted(() => {
    window.removeEventListener('focus', onFocus)
  })
  const findings = computed(() =>
    pu66StatusFinding(status.value, unavailable.value || loading.value),
  )
  return { status, loading, unavailable, findings, reload, version }
}
