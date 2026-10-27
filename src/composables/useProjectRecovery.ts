import { watch, type Ref, type WatchSource } from 'vue'
import { storeToRefs } from 'pinia'
import { useProjectSessionUiStore, type ProjectSessionUiRefs } from '../stores/project-session-ui'
import {
  RecoverySession,
  RECOVERY_HEARTBEAT_MS,
  type RecoveryRepository,
  type RecoverySnapshot,
} from '../application/recovery-session'
import type { RecoverySummary } from '../domain/recovery'

export interface ProjectRecoveryOptions {
  initialId: string
  repository: RecoveryRepository & { releaseOnExit(id: string): void }
  list(): Promise<RecoverySummary[]>
  snapshot(id: string): RecoverySnapshot | null
  hasUnsavedWork: Readonly<Ref<boolean>>
  changes: WatchSource[]
  showError(cause: unknown): void
}

/** Debounce and ownership adapter around the existing serialized application workflow. */
export function useProjectRecovery(
  options: ProjectRecoveryOptions,
  state: Pick<
    ProjectSessionUiRefs,
    'recoveryCopies' | 'recoveryStatus' | 'activeRecoveryId'
  > = storeToRefs(useProjectSessionUiStore()),
) {
  const recovery = new RecoverySession(options.repository)
  const { recoveryCopies, recoveryStatus, activeRecoveryId } = state
  activeRecoveryId.value = options.initialId
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null
  let recoveryTimer: ReturnType<typeof setTimeout> | null = null
  let changes = 0
  let generation = 0
  let heartbeatFlight: Promise<void> | null = null

  async function refresh(): Promise<void> {
    try {
      recoveryCopies.value = await options.list()
    } catch (cause) {
      options.showError(cause)
    }
  }

  function cancelTimer(): void {
    if (recoveryTimer) clearTimeout(recoveryTimer)
    recoveryTimer = null
  }

  function begin(id: string): void {
    generation++
    cancelTimer()
    if (id !== activeRecoveryId.value)
      void recovery.release(activeRecoveryId.value).catch(options.showError)
    activeRecoveryId.value = id
    recoveryStatus.value = 'idle'
  }

  async function clear(id: string): Promise<void> {
    await recovery.remove(id)
    if (id === activeRecoveryId.value && !options.hasUnsavedWork.value)
      recoveryStatus.value = 'idle'
    await refresh()
  }

  async function flush(): Promise<boolean> {
    cancelTimer()
    const snapshot = options.snapshot(activeRecoveryId.value)
    if (!snapshot) return true
    const id = activeRecoveryId.value
    const started = generation
    const change = changes
    recoveryStatus.value = 'saving'
    const write = recovery.save(snapshot)
    try {
      await write
      if (started === generation && id === activeRecoveryId.value) {
        if (change === changes) recoveryStatus.value = 'saved'
        else schedule()
      }
      await refresh()
      return true
    } catch (cause) {
      if (started === generation && id === activeRecoveryId.value) {
        recoveryStatus.value = 'error'
        options.showError(cause)
      }
      return false
    }
  }

  function schedule(): void {
    changes++
    cancelTimer()
    if (!options.snapshot(activeRecoveryId.value)) {
      if (recovery.version(activeRecoveryId.value) > 0)
        void clear(activeRecoveryId.value).catch(options.showError)
      else recoveryStatus.value = 'idle'
      return
    }
    recoveryStatus.value = 'pending'
    recoveryTimer = setTimeout(() => void flush(), 800)
  }

  // Applied document, pending forms and base revision jointly define the recoverable snapshot.
  watch(options.changes, schedule)
  // Invalidate an acknowledgement immediately, while batching snapshot scheduling/cleanup.
  watch(
    options.changes,
    () => {
      changes++
      if (options.snapshot(activeRecoveryId.value)) recoveryStatus.value = 'pending'
    },
    { flush: 'sync' },
  )

  function beforeUnload(event: BeforeUnloadEvent): void {
    if (options.hasUnsavedWork.value && recoveryStatus.value !== 'saved') event.preventDefault()
  }

  function releaseOnExit(): void {
    if (recovery.version(activeRecoveryId.value))
      options.repository.releaseOnExit(activeRecoveryId.value)
  }

  async function renewAndRetry(): Promise<void> {
    const id = activeRecoveryId.value
    const started = generation
    try {
      await recovery.heartbeat(id)
    } catch (cause) {
      if (started === generation && id === activeRecoveryId.value) {
        recoveryStatus.value = 'error'
        options.showError(cause)
      }
      await refresh()
      return
    }
    if (started !== generation || id !== activeRecoveryId.value) return
    // Waking/returning confirms ownership before retrying the latest unsaved input.
    // A successful renewal alone never acknowledges a failed or newer snapshot.
    if (recoveryStatus.value !== 'saved' && options.snapshot(id)) await flush()
    else await refresh()
  }

  function heartbeat(): Promise<void> {
    // pageshow, visibilitychange and an overdue interval may arrive together after sleep.
    if (heartbeatFlight) return heartbeatFlight
    heartbeatFlight = renewAndRetry().finally(() => {
      heartbeatFlight = null
    })
    return heartbeatFlight
  }

  function start(): void {
    heartbeatTimer = setInterval(() => void heartbeat(), RECOVERY_HEARTBEAT_MS)
    void refresh()
  }

  function stop(): void {
    generation++
    if (heartbeatTimer) clearInterval(heartbeatTimer)
    void recovery.release(activeRecoveryId.value).catch(options.showError)
    cancelTimer()
  }

  return {
    recoveryCopies,
    recoveryStatus,
    activeRecoveryId,
    begin,
    clear,
    flush,
    beforeUnload,
    releaseOnExit,
    heartbeat,
    start,
    stop,
    claim: (id: string, version: number) => recovery.claim(id, version),
    remove: (id: string, version: number) => recovery.remove(id, version),
    refresh,
  }
}
