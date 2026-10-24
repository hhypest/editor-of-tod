import { watch, type WatchSource } from 'vue'
import type { RevisionCursor } from '../application/project-revisions'

/** Session identity changes even when opening the same project id again. */
export function useSessionCursor(sources: WatchSource[]) {
  let session = 0
  let edit = 0
  // Detect form input synchronously, before an async response or Vue's next render/watch batch.
  watch(sources, () => edit++, { flush: 'sync' })
  return {
    begin(): void {
      session++
    },
    snapshot: (): RevisionCursor => ({ session, edit }),
  }
}
