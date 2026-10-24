import { effectScope, nextTick, ref, shallowRef } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import raw from '../../../tests/fixtures/manual-v1.json?raw'
import { importSchemeJson } from '../../domain/import'
import type { RecoveryReceipt, RecoveryRepository } from '../../application/recovery-session'
import { useProjectRecovery } from '../useProjectRecovery'

const cleanups: Array<() => void> = []
beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  cleanups.splice(0).forEach((stop) => stop())
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
  const scheme = shallowRef(importSchemeJson(raw).scheme)
  const dirty = ref(true)
  const repository = {
    save: vi.fn<RecoveryRepository['save']>(async () => ({
      version: 1,
      updatedAt: '2030-01-01T00:00:00Z',
    })),
    claim: vi.fn(),
    remove: vi.fn(async () => undefined),
    heartbeat: vi.fn(async () => undefined),
    release: vi.fn(async () => undefined),
    releaseOnExit: vi.fn(),
  }
  const showError = vi.fn()
  const scope = effectScope()
  const recovery = scope.run(() =>
    useProjectRecovery({
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
    }),
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
  return { scheme, dirty, repository, showError, recovery, edit }
}

describe('recovery adapter without a mounted component or browser', () => {
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
