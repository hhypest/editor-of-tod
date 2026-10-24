import { ref, watch, type Ref, type WatchSource } from 'vue'
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
export function useProjectRecovery(options: ProjectRecoveryOptions) {
  const recovery = new RecoverySession(options.repository)
  const recoveryCopies = ref<RecoverySummary[]>([])
  const recoveryStatus = ref<'idle' | 'pending' | 'saving' | 'saved' | 'error'>('idle')
  const activeRecoveryId = ref(options.initialId)
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null
  let recoveryTimer: ReturnType<typeof setTimeout> | null = null
  let changes = 0

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
    const change = changes
    recoveryStatus.value = 'saving'
    const write = recovery.save(snapshot)
    try {
      await write
      if (id === activeRecoveryId.value) {
        if (change === changes) recoveryStatus.value = 'saved'
        else schedule()
      }
      await refresh()
      return true
    } catch (cause) {
      if (id === activeRecoveryId.value) {
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

  function beforeUnload(event: BeforeUnloadEvent): void {
    if (options.hasUnsavedWork.value && recoveryStatus.value !== 'saved') event.preventDefault()
  }

  function releaseOnExit(): void {
    if (recovery.version(activeRecoveryId.value))
      options.repository.releaseOnExit(activeRecoveryId.value)
  }

  async function heartbeat(): Promise<void> {
    const id = activeRecoveryId.value
    try {
      await recovery.heartbeat(id)
    } catch (cause) {
      if (id === activeRecoveryId.value) {
        recoveryStatus.value = 'error'
        options.showError(cause)
      }
    }
    await refresh()
  }

  function start(): void {
    heartbeatTimer = setInterval(() => void heartbeat(), RECOVERY_HEARTBEAT_MS)
    void refresh()
  }

  function stop(): void {
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
