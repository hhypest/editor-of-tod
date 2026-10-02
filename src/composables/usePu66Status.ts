import { computed, onMounted, onUnmounted, ref, watch, type Ref } from 'vue'
import { getPu66Status } from '../services/local-pu66'
import { pu66StatusFinding, type Pu66Status } from '../domain/pu66-lifecycle'

/** Invalidate open projects after registry edits without touching their saved snapshots. */
const version = ref(0)
type StatusState = { status: Pu66Status | null; unavailable: boolean; loading: boolean }
const states = ref<Record<string, StatusState>>({})
const requests = new Map<string, Promise<void>>()
export function invalidatePu66Status(): void {
  version.value++
}

/** Source, checklist and sheet share one response, including the check before output. */
async function reloadKey(key: string): Promise<void> {
  if (!key) return
  const pending = requests.get(key)
  if (pending) return pending
  states.value[key] ??= { status: null, unavailable: false, loading: false }
  const state = states.value[key]!
  state.loading = true
  const request = (async () => {
    try {
      let started: number
      do {
        started = version.value
        try {
          state.status = await getPu66Status(key)
          state.unavailable = false
        } catch {
          state.unavailable = true
        }
        // An edit completed while reading; do not accept the earlier result for output.
      } while (started !== version.value)
    } finally {
      state.loading = false
      requests.delete(key)
    }
  })()
  requests.set(key, request)
  return request
}

export function usePu66Status(key: Ref<string>) {
  const status = computed(() => states.value[key.value]?.status ?? null)
  const unavailable = computed(() => states.value[key.value]?.unavailable ?? false)
  const loading = computed(() => states.value[key.value]?.loading ?? false)
  const reload = () => reloadKey(key.value)
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
