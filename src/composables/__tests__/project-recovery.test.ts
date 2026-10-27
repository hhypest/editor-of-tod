import { effectScope, nextTick, ref, shallowRef } from 'vue'
import { createPinia, setActivePinia, storeToRefs } from 'pinia'
import { useProjectSessionUiStore } from '../../stores/project-session-ui'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import raw from '../../../tests/fixtures/manual-v1.json?raw'
import { importSchemeJson } from '../../domain/import'
import type { RecoveryReceipt, RecoveryRepository } from '../../application/recovery-session'
import { useProjectRecovery } from '../useProjectRecovery'

const cleanups: Array<() => void> = []
beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  cleanups.splice(0).forEach((stop) => stop())
  setActivePinia(undefined)
  vi.useRealTimers()
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}

function harness() {
  const pinia = createPinia()
  const state = storeToRefs(useProjectSessionUiStore(pinia))
  const scheme = shallowRef(importSchemeJson(raw).scheme)
  const dirty = ref(true)
  const repository = {
    save: vi.fn<RecoveryRepository['save']>(async () => ({
      version: 1,
      updatedAt: '2030-01-01T00:00:00Z',
    })),
    claim: vi.fn(),
    remove: vi.fn(async () => undefined),
    heartbeat: vi.fn<RecoveryRepository['heartbeat']>(async () => undefined),
    release: vi.fn(async () => undefined),
    releaseOnExit: vi.fn(),
  }
  const showError = vi.fn()
  const scope = effectScope()
  const recovery = scope.run(() =>
    useProjectRecovery(
      {
        initialId: 'first',
        repository,
        list: async () => [],
        hasUnsavedWork: dirty,
        changes: [scheme, dirty],
        showError,
        snapshot(sessionId) {
          return dirty.value
            ? {
                sessionId,
                scheme: scheme.value,
                baseRevision: null,
                detailsDraft: null,
                placementDraft: null,
                fileName: 'учебный.json',
              }
            : null
        },
      },
      state,
    ),
  )!
  cleanups.push(() => {
    recovery.stop()
    scope.stop()
  })
  const edit = (text: string) => {
    scheme.value = {
      ...scheme.value,
      parameters: { ...scheme.value.parameters, locationText: text },
    }
  }
  return { scheme, dirty, repository, showError, recovery, edit, pinia, state }
}

describe('recovery adapter without a mounted component or browser', () => {
  it('shares a live projection without resetting or starting another recovery owner', async () => {
    const { recovery, repository, edit, pinia, state } = harness()
    edit('Общий ввод')
    await nextTick()
    const timers = vi.getTimerCount()
    const reader = storeToRefs(useProjectSessionUiStore(pinia))
    expect(reader.activeRecoveryId.value).toBe('first')
    expect(reader.recoveryStatus.value).toBe('pending')
    expect(vi.getTimerCount()).toBe(timers)
    const other = useProjectSessionUiStore(createPinia())
    setActivePinia(createPinia())
    await recovery.flush()
    expect(reader.recoveryStatus.value).toBe('saved')
    expect(state.recoveryStatus.value).toBe('saved')
    expect(other.recoveryStatus).toBe('idle')
    expect(other.activeRecoveryId).toBe('')
    expect(repository.save).toHaveBeenCalledTimes(1)
    expect(repository.heartbeat).not.toHaveBeenCalled()
  })

  it('initializes the projection without starting requests or timers', () => {
    const { recovery, repository } = harness()
    expect(recovery.activeRecoveryId.value).toBe('first')
    expect(recovery.recoveryStatus.value).toBe('idle')
    expect(recovery.recoveryCopies.value).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
    expect(repository.save).not.toHaveBeenCalled()
    expect(repository.heartbeat).not.toHaveBeenCalled()
  })

  it('preserves pending input and copies when beginning another recovery id', async () => {
    const { recovery, edit, scheme, dirty } = harness()
    edit('Неприменённый ввод')
    await nextTick()
    const before = scheme.value
    const copies = recovery.recoveryCopies.value
    recovery.begin('second')
    expect(recovery.activeRecoveryId.value).toBe('second')
    expect(recovery.recoveryStatus.value).toBe('idle')
    expect(recovery.recoveryCopies.value).toBe(copies)
    expect(scheme.value).toBe(before)
    expect(dirty.value).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('retries a failed snapshot after wake and captures the latest unapplied input', async () => {
    const { repository, recovery, edit } = harness()
    repository.save.mockRejectedValueOnce(new Error('Нет связи'))
    edit('До сна')
    await vi.advanceTimersByTimeAsync(800)
    expect(recovery.recoveryStatus.value).toBe('error')
    // Suspend advances wall time without running the window's timers.
    vi.setSystemTime(Date.now() + 180_000)
    edit('Ввод после пробуждения')
    await recovery.heartbeat()
    expect(repository.save).toHaveBeenCalledTimes(2)
    expect(repository.save.mock.calls[1]?.[0]).toMatchObject({
      expectedVersion: 0,
      scheme: { parameters: { locationText: 'Ввод после пробуждения' } },
    })
    expect(recovery.recoveryStatus.value).toBe('saved')
  })

  it('coalesces wake events and does not acknowledge renewal before the retried save', async () => {
    const { repository, recovery, edit } = harness()
    await recovery.flush()
    edit('Неприменённый ввод')
    const renew = deferred<void>()
    const save = deferred<RecoveryReceipt>()
    repository.heartbeat.mockImplementationOnce(() => renew.promise)
    repository.save.mockImplementationOnce(() => save.promise)
    const wake = recovery.heartbeat()
    const anotherWake = recovery.heartbeat()
    expect(wake).toBe(anotherWake)
    await vi.advanceTimersByTimeAsync(0)
    expect(repository.heartbeat).toHaveBeenCalledTimes(1)
    renew.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(recovery.recoveryStatus.value).toBe('saving')
    edit('Ещё более новый ввод')
    save.resolve({ version: 2, updatedAt: '2030-01-01T00:00:01Z' })
    await wake
    expect(recovery.recoveryStatus.value).toBe('pending')
    await vi.advanceTimersByTimeAsync(800)
    expect(repository.save.mock.calls.at(-1)?.[0].scheme.parameters.locationText).toBe(
      'Ещё более новый ввод',
    )
    expect(recovery.recoveryStatus.value).toBe('saved')
  })

  it('keeps failed renewal unsaved and retries after the connection returns', async () => {
    const { repository, recovery, edit } = harness()
    await recovery.flush()
    repository.heartbeat.mockRejectedValueOnce(new Error('Нет сети'))
    edit('После сна')
    await recovery.heartbeat()
    expect(repository.save).toHaveBeenCalledTimes(1)
    expect(recovery.recoveryStatus.value).toBe('error')
    await recovery.heartbeat()
    expect(repository.save).toHaveBeenCalledTimes(2)
    expect(recovery.recoveryStatus.value).toBe('saved')
  })

  it('keeps edits when claim wins between renewal and the queued retry', async () => {
    const { repository, recovery, edit, scheme, showError } = harness()
    await recovery.flush()
    edit('Не отдать другому окну')
    const before = scheme.value
    repository.save.mockRejectedValueOnce(new Error('Другой владелец'))
    await recovery.heartbeat()
    expect(recovery.recoveryStatus.value).toBe('error')
    expect(scheme.value).toBe(before)
    expect(showError).toHaveBeenCalledTimes(1)
    expect(repository.claim).not.toHaveBeenCalled()
    expect(repository.remove).not.toHaveBeenCalled()
  })

  it.each([false, true])(
    'ignores a late renewal after switching or reopening (same id: %s)',
    async (sameId) => {
      const { repository, recovery, edit } = harness()
      await recovery.flush()
      const renew = deferred<void>()
      repository.heartbeat.mockImplementationOnce(() => renew.promise)
      const wake = recovery.heartbeat()
      await vi.advanceTimersByTimeAsync(0)
      recovery.begin(sameId ? 'first' : 'second')
      edit('Новая сессия')
      renew.resolve()
      await wake
      expect(repository.save).toHaveBeenCalledTimes(1)
      expect(recovery.recoveryStatus.value).toBe('pending')
    },
  )

  it('debounces edits and keeps a newer edit pending until its own queued write finishes', async () => {
    const { repository, recovery, edit } = harness()
    const first = deferred<RecoveryReceipt>()
    const second = deferred<RecoveryReceipt>()
    repository.save
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise)
    edit('Первая')
    await nextTick()
    await vi.advanceTimersByTimeAsync(400)
    edit('Объединённая')
    await nextTick()
    await vi.advanceTimersByTimeAsync(799)
    expect(repository.save).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(repository.save).toHaveBeenCalledTimes(1)
    edit('Новая во время записи')
    await nextTick()
    first.resolve({ version: 1, updatedAt: '2030-01-01T00:00:00Z' })
    await vi.advanceTimersByTimeAsync(800)
    expect(repository.save).toHaveBeenCalledTimes(2)
    expect(repository.save.mock.calls[1]?.[0]).toMatchObject({
      expectedVersion: 1,
      scheme: { parameters: { locationText: 'Новая во время записи' } },
    })
    expect(recovery.recoveryStatus.value).toBe('saving')
    const unload = new Event('beforeunload', { cancelable: true }) as BeforeUnloadEvent
    recovery.beforeUnload(unload)
    expect(unload.defaultPrevented).toBe(true)
    second.resolve({ version: 2, updatedAt: '2030-01-01T00:00:01Z' })
    await vi.advanceTimersByTimeAsync(0)
    expect(recovery.recoveryStatus.value).toBe('saved')
  })

  it('does not mark a switched session saved when an older response arrives', async () => {
    const { repository, recovery, edit } = harness()
    const first = deferred<RecoveryReceipt>()
    repository.save.mockImplementationOnce(() => first.promise)
    edit('Прежний проект')
    await nextTick()
    await vi.advanceTimersByTimeAsync(800)
    recovery.begin('second')
    edit('Другой проект')
    await nextTick()
    first.resolve({ version: 1, updatedAt: '2030-01-01T00:00:00Z' })
    await vi.advanceTimersByTimeAsync(0)
    expect(recovery.activeRecoveryId.value).toBe('second')
    expect(recovery.recoveryStatus.value).toBe('pending')
    expect(repository.release).toHaveBeenCalledWith('first')
  })

  it('keeps unsaved input and the unload warning when a heartbeat loses ownership', async () => {
    const { repository, recovery, scheme, edit, showError } = harness()
    edit('Правки')
    await nextTick()
    await vi.advanceTimersByTimeAsync(800)
    const before = scheme.value
    repository.heartbeat.mockRejectedValueOnce(new Error('Владелец изменился'))
    await recovery.heartbeat()
    expect(recovery.recoveryStatus.value).toBe('error')
    expect(scheme.value).toBe(before)
    expect(showError).toHaveBeenCalledTimes(1)
    const unload = new Event('beforeunload', { cancelable: true }) as BeforeUnloadEvent
    recovery.beforeUnload(unload)
    expect(unload.defaultPrevented).toBe(true)
  })

  it('stops both timers and releases only a known owned copy on exit', async () => {
    const { repository, recovery, edit } = harness()
    recovery.releaseOnExit()
    expect(repository.releaseOnExit).not.toHaveBeenCalled()
    recovery.start()
    edit('Записано')
    await nextTick()
    await vi.advanceTimersByTimeAsync(800)
    recovery.releaseOnExit()
    expect(repository.releaseOnExit).toHaveBeenCalledWith('first')
    edit('Не отправлять после остановки')
    await nextTick()
    recovery.stop()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(repository.save).toHaveBeenCalledTimes(1)
    expect(repository.heartbeat).not.toHaveBeenCalled()
    expect(repository.release).toHaveBeenCalledWith('first')
  })
})
