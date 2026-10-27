import { defineStore } from 'pinia'
import { ref } from 'vue'
import { getPu66Status } from '../services/local-pu66'
import type { Pu66Status } from '../domain/pu66-lifecycle'

/** Shared status responses and invalidation belong to one app, not the module. */
export const usePu66StatusStore = defineStore('pu66Status', () => {
  const version = ref(0)
  type StatusState = { status: Pu66Status | null; unavailable: boolean; loading: boolean }
  const states = ref<Record<string, StatusState>>({})
  const requests = new Map<string, Promise<void>>()
  function invalidate(): void {
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

  return { version, states, invalidate, reloadKey }
})
