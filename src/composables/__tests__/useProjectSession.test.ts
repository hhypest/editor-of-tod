import { createRenderer, defineComponent, nextTick } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Scheme } from '../../domain/model'
import type { ProjectRecord } from '../../domain/local-projects'
import raw from '../../../tests/fixtures/manual-v1.json?raw'
import { useProjectSession } from '../useProjectSession'

const local = vi.hoisted(() => ({
  saveLocalProject: vi.fn<(scheme: Scheme, revision: number) => Promise<ProjectRecord>>(),
  restoreLocalRevision:
    vi.fn<(id: string, source: number, revision: number) => Promise<ProjectRecord>>(),
  getLocalProject: vi.fn<(id: string) => Promise<ProjectRecord>>(),
  listRecoveryDrafts: vi.fn(async () => []),
  saveRecoveryDraft: vi.fn(async () => ({ version: 1 })),
  deleteRecoveryDraft: vi.fn<() => Promise<void>>(async () => undefined),
  heartbeat: vi.fn(async () => undefined),
  releaseOnExit: vi.fn(),
}))
vi.mock('../../services/local-projects', () => ({
  ...local,
  createRecoveryRepository: () => ({
    save: local.saveRecoveryDraft,
    remove: local.deleteRecoveryDraft,
    claim: vi.fn(),
    heartbeat: local.heartbeat,
    release: vi.fn(async () => undefined),
    releaseOnExit: local.releaseOnExit,
  }),
}))
vi.mock('../useNormativeRules', async () => {
  const { ref } = await import('vue')
  const { PROTOTYPE_RULES } = await import('../../domain/normative-parameters')
  return { useNormativeRules: () => ({ rules: ref(PROTOTYPE_RULES) }) }
})
vi.mock('../../services/diagnostics', () => ({ reportError: vi.fn() }))

// Настоящий lifecycle Vue с минимальным host: проверяем сессию без зависимости от браузерного DOM.
type Host = { children: Host[] }
const renderer = createRenderer<Host, Host>({
  createElement: () => ({ children: [] }),
  createText: () => ({ children: [] }),
  createComment: () => ({ children: [] }),
  insert: (node, parent) => parent.children.push(node),
  remove: () => undefined,
  setText: () => undefined,
  setElementText: () => undefined,
  patchProp: () => undefined,
  parentNode: () => null,
  nextSibling: () => null,
})
let unmount: () => void
beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  local.saveRecoveryDraft.mockResolvedValue({ version: 1 })
  local.heartbeat.mockResolvedValue(undefined)
  local.deleteRecoveryDraft.mockResolvedValue(undefined)
  local.saveLocalProject.mockReset()
  local.restoreLocalRevision.mockReset()
  local.getLocalProject.mockReset()
  vi.stubGlobal(
    'window',
    Object.assign(new EventTarget(), { setTimeout, confirm: vi.fn(() => true) }),
  )
  vi.stubGlobal(
    'document',
    Object.assign(new EventTarget(), {
      body: { append: vi.fn() },
      createElement: () => ({ click: vi.fn(), remove: vi.fn() }),
    }),
  )
})
afterEach(() => {
  unmount?.()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

async function openEditedSession() {
  let session!: ReturnType<typeof useProjectSession>
  const app = renderer.createApp(
    defineComponent({
      setup() {
        session = useProjectSession(() => undefined)
        return () => null
      },
    }),
  )
  app.mount({ children: [] })
  unmount = () => app.unmount()
  await session.onFileSelected({
    target: {
      files: [{ name: 'synthetic.json', size: raw.length, text: async () => raw }],
      value: '',
    },
  } as unknown as Event)
  const scheme = session.imported.value!.scheme
  session.onProjectApplied({
    ...scheme,
    parameters: { ...scheme.parameters, locationText: 'Учебная правка' },
  })
  await nextTick()
  await vi.advanceTimersByTimeAsync(800)
  return session
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

const record = (scheme: Scheme, revision = 1): ProjectRecord => ({
  scheme,
  revision,
  updatedAt: new Date().toISOString(),
})

function edit(session: Awaited<ReturnType<typeof openEditedSession>>, locationText: string) {
  const scheme = session.imported.value!.scheme
  session.onProjectApplied({ ...scheme, parameters: { ...scheme.parameters, locationText } })
}

describe('project revision contracts', () => {
  it('acknowledges a save without replacing the scheme or clearing undo/redo history', async () => {
    const session = await openEditedSession()
    const scheme = session.imported.value!.scheme
    const history = session.history.value
    local.saveLocalProject.mockResolvedValue(record(scheme))
    await session.saveLocally()
    expect(local.saveLocalProject).toHaveBeenCalledWith(scheme, 0)
    expect(session.imported.value!.scheme).toBe(scheme)
    expect(session.history.value).toBe(history)
    expect(session.localRevision.value).toBe(1)
    expect(session.hasUnsavedWork.value).toBe(false)
    session.stepBack()
    expect(session.imported.value!.scheme.parameters.locationText).not.toBe('Учебная правка')
    session.stepForward()
    expect(session.imported.value!.scheme).toBe(scheme)
    expect(session.hasUnsavedWork.value).toBe(true)
  })

  it('acknowledges a repeated save without adding a revision or resetting history', async () => {
    const session = await openEditedSession()
    session.localRevision.value = 3
    const scheme = session.imported.value!.scheme
    const history = session.history.value
    local.saveLocalProject.mockResolvedValue(record(scheme, 3))
    await session.saveLocally()
    expect(session.localRevision.value).toBe(3)
    expect(session.localError.value).toBe('')
    expect(session.hasUnsavedWork.value).toBe(false)
    expect(session.history.value).toBe(history)
  })

  it('does not save unapplied input or start a second concurrent save', async () => {
    const session = await openEditedSession()
    session.detailsDirty.value = true
    await session.saveLocally()
    expect(local.saveLocalProject).not.toHaveBeenCalled()
    session.detailsDirty.value = false
    const response = deferred<ProjectRecord>()
    local.saveLocalProject.mockReturnValue(response.promise)
    const saving = session.saveLocally()
    await session.saveLocally()
    expect(local.saveLocalProject).toHaveBeenCalledTimes(1)
    response.resolve(record(session.imported.value!.scheme))
    await saving
  })

  it('keeps newer edits and their recovery copy while advancing the saved revision', async () => {
    const session = await openEditedSession()
    const before = session.imported.value!.scheme
    const response = deferred<ProjectRecord>()
    local.saveLocalProject.mockReturnValue(response.promise)
    const saving = session.saveLocally()
    edit(session, 'Правка во время сохранения')
    const history = session.history.value
    response.resolve(record(before))
    await saving
    expect(session.imported.value!.scheme.parameters.locationText).toBe(
      'Правка во время сохранения',
    )
    expect(session.history.value).toBe(history)
    expect(session.localRevision.value).toBe(1)
    expect(session.hasUnsavedWork.value).toBe(true)
    expect(local.deleteRecoveryDraft).not.toHaveBeenCalled()
  })

  it('rechecks edits at the UI boundary after the workflow has already received its response', async () => {
    const session = await openEditedSession()
    const before = session.imported.value!.scheme
    const response = deferred<ProjectRecord>()
    local.saveLocalProject.mockReturnValue(response.promise)
    const saving = session.saveLocally()
    // This callback runs after the workflow's await but before the Vue adapter's await.
    const editing = response.promise.then(() => edit(session, 'Правка между обработчиками ответа'))
    response.resolve(record(before))
    await Promise.all([saving, editing])
    expect(session.imported.value!.scheme.parameters.locationText).toBe(
      'Правка между обработчиками ответа',
    )
    expect(session.hasUnsavedWork.value).toBe(true)
    expect(local.deleteRecoveryDraft).not.toHaveBeenCalled()
  })

  it('keeps the document, revision and history when restore conflicts', async () => {
    const session = await openEditedSession()
    session.localRevision.value = 3
    const scheme = session.imported.value!.scheme
    const history = session.history.value
    local.restoreLocalRevision.mockRejectedValue(new Error('Запись изменилась в другом окне.'))
    await session.restoreLocal(scheme.id, 1, 3)
    expect(local.restoreLocalRevision).toHaveBeenCalledWith(scheme.id, 1, 3)
    expect(session.imported.value!.scheme).toBe(scheme)
    expect(session.history.value).toBe(history)
    expect(session.localRevision.value).toBe(3)
    expect(session.hasUnsavedWork.value).toBe(true)
    expect(local.deleteRecoveryDraft).not.toHaveBeenCalled()
  })

  it('does not report recovery cleanup failure as a failed project save', async () => {
    const session = await openEditedSession()
    local.saveLocalProject.mockResolvedValue(record(session.imported.value!.scheme))
    local.deleteRecoveryDraft.mockRejectedValue(new Error('Ошибка удаления копии'))
    await session.saveLocally()
    await nextTick()
    expect(session.localRevision.value).toBe(1)
    expect(session.hasUnsavedWork.value).toBe(false)
    expect(session.localError.value).toBe('')
    expect(session.localNotice.value).toContain('Копию восстановления удалить не удалось')
  })

  it('keeps input started during a save and does not remove its recovery copy', async () => {
    const session = await openEditedSession()
    const response = deferred<ProjectRecord>()
    local.saveLocalProject.mockReturnValue(response.promise)
    const saving = session.saveLocally()
    session.detailsDirty.value = true
    response.resolve(record(session.imported.value!.scheme))
    await saving
    expect(session.hasUnsavedWork.value).toBe(true)
    expect(local.deleteRecoveryDraft).not.toHaveBeenCalled()
  })

  it('does not apply a late save revision to a newly opened JSON session', async () => {
    const session = await openEditedSession()
    const response = deferred<ProjectRecord>()
    const before = session.imported.value!.scheme
    local.saveLocalProject.mockReturnValue(response.promise)
    const saving = session.saveLocally()
    // Reopening the same id is still a different editor session.
    await session.onFileSelected({
      target: {
        files: [{ name: 'other.json', size: raw.length, text: async () => JSON.stringify(before) }],
        value: '',
      },
    } as unknown as Event)
    const history = session.history.value
    response.resolve(record(before))
    await saving
    expect(session.localRevision.value).toBeNull()
    expect(session.history.value).toBe(history)
    expect(session.localNotice.value).toBe('')
    expect(local.deleteRecoveryDraft).not.toHaveBeenCalled()
    expect(session.projectsRefreshKey.value).toBe(1)
  })

  it.each(['restore', 'copy'] as const)(
    'ignores a late %s acknowledgement after reopening the same id',
    async (operation) => {
      const session = await openEditedSession()
      session.localRevision.value = 3
      const before = session.imported.value!.scheme
      const response = deferred<ProjectRecord>()
      local.restoreLocalRevision.mockReturnValue(response.promise)
      local.saveLocalProject.mockReturnValue(response.promise)
      const pending =
        operation === 'restore' ? session.restoreLocal(before.id, 1, 3) : session.saveAsNew()
      await vi.waitFor(() =>
        expect(
          operation === 'restore' ? local.restoreLocalRevision : local.saveLocalProject,
        ).toHaveBeenCalledTimes(1),
      )
      await session.onFileSelected({
        target: {
          files: [
            { name: 'same-id.json', size: raw.length, text: async () => JSON.stringify(before) },
          ],
          value: '',
        },
      } as unknown as Event)
      const history = session.history.value
      const savedScheme =
        operation === 'restore' ? before : local.saveLocalProject.mock.calls[0]![0]
      response.resolve(record(savedScheme, operation === 'restore' ? 4 : 1))
      await pending
      expect(session.imported.value!.scheme.id).toBe(before.id)
      expect(session.localRevision.value).toBeNull()
      expect(session.history.value).toBe(history)
      expect(session.localNotice.value).toBe('')
      expect(session.projectsRefreshKey.value).toBe(1)
      expect(local.deleteRecoveryDraft).not.toHaveBeenCalled()
    },
  )

  it('keeps edits made after confirming a restore and acknowledges the new database revision', async () => {
    const session = await openEditedSession()
    session.localRevision.value = 3
    const before = session.imported.value!.scheme
    const response = deferred<ProjectRecord>()
    local.restoreLocalRevision.mockReturnValue(response.promise)
    const restoring = session.restoreLocal(before.id, 1, 3)
    await vi.waitFor(() => expect(local.restoreLocalRevision).toHaveBeenCalledTimes(1))
    edit(session, 'Правка после подтверждения')
    const history = session.history.value
    response.resolve(record(before, 4))
    await restoring
    expect(session.imported.value!.scheme.parameters.locationText).toBe(
      'Правка после подтверждения',
    )
    expect(session.history.value).toBe(history)
    expect(session.localRevision.value).toBe(4)
    expect(session.hasUnsavedWork.value).toBe(true)
    expect(local.deleteRecoveryDraft).not.toHaveBeenCalled()
  })

  it('preserves state on a save conflict and retries with the original expected revision', async () => {
    const session = await openEditedSession()
    session.localRevision.value = 3
    const scheme = session.imported.value!.scheme
    const history = session.history.value
    local.saveLocalProject.mockRejectedValueOnce(new Error('Запись изменилась в другом окне.'))
    await session.saveLocally()
    expect(session.imported.value!.scheme).toBe(scheme)
    expect(session.history.value).toBe(history)
    expect(session.localRevision.value).toBe(3)
    expect(session.localBusy.value).toBe(false)
    expect(session.hasUnsavedWork.value).toBe(true)
    expect(session.localError.value).toContain('Ваши правки остались открытыми')
    local.saveLocalProject.mockResolvedValue(record(scheme, 4))
    await session.saveLocally()
    expect(local.saveLocalProject.mock.calls.map((call) => call[1])).toEqual([3, 3])
    expect(session.localRevision.value).toBe(4)
    expect(session.localError.value).toBe('')
  })

  it('does not restore after input changes while the recovery snapshot is being saved', async () => {
    const session = await openEditedSession()
    session.localRevision.value = 3
    const scheme = session.imported.value!.scheme
    const response = deferred<{ version: number }>()
    local.saveRecoveryDraft.mockReturnValueOnce(response.promise)
    const restoring = session.restoreLocal(scheme.id, 1, 3)
    await vi.waitFor(() => expect(local.saveRecoveryDraft).toHaveBeenCalledTimes(2))
    session.placementDirty.value = true
    response.resolve({ version: 2 })
    await restoring
    expect(local.restoreLocalRevision).not.toHaveBeenCalled()
    expect(session.localNotice.value).toContain('подтвердите возврат к версии заново')
    expect(session.localBusy.value).toBe(false)
    expect(session.localRevision.value).toBe(3)
    expect(session.imported.value!.scheme).toBe(scheme)
    expect(session.placementDirty.value).toBe(true)
  })

  it('does not write when restore confirmation is cancelled', async () => {
    const session = await openEditedSession()
    session.localRevision.value = 3
    vi.mocked(window.confirm).mockReturnValueOnce(false)
    const history = session.history.value
    await session.restoreLocal(session.imported.value!.scheme.id, 1, 3)
    expect(local.restoreLocalRevision).not.toHaveBeenCalled()
    expect(session.history.value).toBe(history)
    expect(session.localRevision.value).toBe(3)
  })

  it('keeps an unapplied form and redo history when they change during restore', async () => {
    const session = await openEditedSession()
    session.localRevision.value = 3
    const scheme = session.imported.value!.scheme
    const response = deferred<ProjectRecord>()
    local.restoreLocalRevision.mockReturnValue(response.promise)
    const restoring = session.restoreLocal(scheme.id, 1, 3)
    await vi.waitFor(() => expect(local.restoreLocalRevision).toHaveBeenCalledTimes(1))
    session.stepBack()
    session.detailsDirty.value = true
    const history = session.history.value
    response.resolve(record(scheme, 4))
    await restoring
    expect(session.detailsDirty.value).toBe(true)
    expect(session.history.value).toBe(history)
    expect(session.history.value!.future).toHaveLength(1)
    expect(session.localRevision.value).toBe(4)
    expect(session.hasUnsavedWork.value).toBe(true)
  })

  it('opens a current restored revision with a new history and preserves its old recovery snapshot', async () => {
    const session = await openEditedSession()
    session.localRevision.value = 3
    const before = session.imported.value!.scheme
    const restored = {
      ...before,
      parameters: { ...before.parameters, locationText: 'Прежняя редакция' },
    }
    local.restoreLocalRevision.mockResolvedValue(record(restored, 4))
    await session.restoreLocal(before.id, 1, 3)
    expect(session.imported.value!.scheme).toBe(restored)
    expect(session.history.value!.past).toEqual([])
    expect(session.history.value!.future).toEqual([])
    expect(session.localRevision.value).toBe(4)
    expect(session.hasUnsavedWork.value).toBe(false)
    expect(local.deleteRecoveryDraft).not.toHaveBeenCalled()
  })

  it('does not show a late save error in a different session', async () => {
    const session = await openEditedSession()
    const response = deferred<ProjectRecord>()
    local.saveLocalProject.mockReturnValue(response.promise)
    const saving = session.saveLocally()
    await session.onFileSelected({
      target: {
        files: [{ name: 'reopened.json', size: raw.length, text: async () => raw }],
        value: '',
      },
    } as unknown as Event)
    response.reject(new Error('Запись изменилась в другом окне.'))
    await saving
    expect(session.localError.value).toBe('')
    expect(session.localRevision.value).toBeNull()
  })

  it('keeps input and pending recovery state when it starts during recovery cleanup', async () => {
    const session = await openEditedSession()
    const response = deferred<void>()
    local.saveLocalProject.mockResolvedValue(record(session.imported.value!.scheme))
    local.deleteRecoveryDraft.mockReturnValueOnce(response.promise)
    const saving = session.saveLocally()
    await vi.waitFor(() => expect(local.deleteRecoveryDraft).toHaveBeenCalledTimes(1))
    session.detailsDirty.value = true
    await nextTick()
    response.resolve(undefined)
    await saving
    expect(session.hasUnsavedWork.value).toBe(true)
    expect(session.recoveryStatus.value).toBe('pending')
    await vi.advanceTimersByTimeAsync(800)
    expect(session.recoveryStatus.value).toBe('saved')
    expect(local.saveRecoveryDraft).toHaveBeenLastCalledWith(
      expect.objectContaining({ expectedVersion: 0 }),
      undefined,
    )
  })

  it('starts a saved copy with a new identity and resets history only on current acknowledgement', async () => {
    const session = await openEditedSession()
    const previousId = session.imported.value!.scheme.id
    const recoveryId = session.activeRecoveryId.value
    local.saveLocalProject.mockImplementation(async (scheme) => record(scheme))
    await session.saveAsNew()
    expect(session.imported.value!.scheme.id).not.toBe(previousId)
    expect(session.activeRecoveryId.value).not.toBe(recoveryId)
    expect(session.history.value!.past).toEqual([])
    expect(session.localRevision.value).toBe(1)
    expect(session.hasUnsavedWork.value).toBe(false)
    expect(local.deleteRecoveryDraft).toHaveBeenCalledTimes(1)
  })

  it('keeps newer edits when saving a separate copy', async () => {
    const session = await openEditedSession()
    const before = session.imported.value!.scheme
    const response = deferred<ProjectRecord>()
    local.saveLocalProject.mockReturnValue(response.promise)
    const saving = session.saveAsNew()
    const copy = local.saveLocalProject.mock.calls[0]![0]
    expect(copy.id).not.toBe(before.id)
    expect(local.saveLocalProject.mock.calls[0]![1]).toBe(0)
    edit(session, 'Новая правка исходного проекта')
    const history = session.history.value
    response.resolve(record(copy))
    await saving
    expect(session.imported.value!.scheme.id).toBe(before.id)
    expect(session.imported.value!.scheme.parameters.locationText).toBe(
      'Новая правка исходного проекта',
    )
    expect(session.history.value).toBe(history)
    expect(session.localRevision.value).toBeNull()
    expect(session.hasUnsavedWork.value).toBe(true)
    expect(local.deleteRecoveryDraft).not.toHaveBeenCalled()
  })
})

describe('JSON export does not acknowledge a database save', () => {
  it('keeps unsaved state and the recovery copy when the download has no save acknowledgement', async () => {
    const session = await openEditedSession()
    expect(session.recoveryStatus.value).toBe('saved')
    session.saveV5()
    await nextTick()
    expect(session.hasUnsavedWork.value).toBe(true)
    expect(session.modifiedSinceLocalSave.value).toBe(true)
    expect(session.recoveryStatus.value).toBe('saved')
    expect(local.deleteRecoveryDraft).not.toHaveBeenCalled()
  })

  it('retains the unload warning after export when recovery writing failed', async () => {
    local.saveRecoveryDraft.mockRejectedValue(new Error('База недоступна'))
    const session = await openEditedSession()
    expect(session.recoveryStatus.value).toBe('error')
    session.saveV5()
    await nextTick()
    const event = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    expect(local.deleteRecoveryDraft).not.toHaveBeenCalled()
  })

  it('retains open edits and the unload warning when another window has taken ownership', async () => {
    const session = await openEditedSession()
    const scheme = session.imported.value!.scheme
    local.heartbeat.mockRejectedValue(new Error('Копия открыта в другом окне.'))
    await vi.advanceTimersByTimeAsync(20_000)
    expect(session.recoveryStatus.value).toBe('error')
    expect(session.imported.value!.scheme).toBe(scheme)
    expect(session.hasUnsavedWork.value).toBe(true)
    expect(session.localError.value).toContain('другом окне')
    const event = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    expect(local.deleteRecoveryDraft).not.toHaveBeenCalled()
  })

  it('releases the owner on pagehide without sending a new snapshot', async () => {
    const session = await openEditedSession()
    const writes = local.saveRecoveryDraft.mock.calls.length
    window.dispatchEvent(new Event('pagehide'))
    expect(local.releaseOnExit).toHaveBeenCalledWith(session.activeRecoveryId.value)
    expect(local.saveRecoveryDraft).toHaveBeenCalledTimes(writes)
  })
})
