import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick } from 'vue'
import { useProjectSession } from '../useProjectSession'
import { importSchemeJson } from '../../domain/import'
import legacy from '../../../tests/fixtures/legacy-b34-manual.json?raw'

const mocks = vi.hoisted(() => ({
  mounted: [] as Array<() => void>,
  unmounted: [] as Array<() => void>,
  saveRecovery: vi.fn(),
  deleteRecovery: vi.fn(),
  saveProject: vi.fn(),
  click: vi.fn(),
}))
vi.mock('vue', async (original) => ({
  ...(await original<typeof import('vue')>()),
  onMounted: (hook: () => void) => mocks.mounted.push(hook),
  onUnmounted: (hook: () => void) => mocks.unmounted.push(hook),
}))
vi.mock('../../services/local-projects', () => ({
  listRecoveryDrafts: async () => [],
  saveRecoveryDraft: mocks.saveRecovery,
  deleteRecoveryDraft: mocks.deleteRecovery,
  saveLocalProject: mocks.saveProject,
  getLocalProject: vi.fn(),
  getRecoveryDraft: vi.fn(),
  restoreLocalRevision: vi.fn(),
}))
vi.mock('../../services/diagnostics', () => ({ reportError: vi.fn() }))

const scopes: ReturnType<typeof effectScope>[] = []
const listeners = new Map<string, (event: { preventDefault: () => void }) => void>()
beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  listeners.clear()
  mocks.mounted.length = 0
  mocks.unmounted.length = 0
  vi.stubGlobal('window', {
    addEventListener: (name: string, callback: (event: { preventDefault: () => void }) => void) =>
      listeners.set(name, callback),
    removeEventListener: (name: string) => listeners.delete(name),
    setTimeout,
    confirm: () => true,
  })
  vi.stubGlobal('document', {
    createElement: () => ({ click: mocks.click, remove: vi.fn() }),
    body: { append: vi.fn() },
  })
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:synthetic')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
  mocks.saveRecovery.mockImplementation(async (input) => ({
    ...input,
    version: input.expectedVersion + 1,
  }))
  mocks.saveProject.mockImplementation(async (scheme) => ({ scheme, revision: 1 }))
})
afterEach(() => {
  for (const hook of mocks.unmounted) hook()
  for (const scope of scopes.splice(0)) scope.stop()
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('project download and recovery lifecycle', () => {
  it('keeps recovery and unload warning after a cancelled JSON download until SQLite save', async () => {
    const scope = effectScope()
    scopes.push(scope)
    const session = scope.run(() => useProjectSession(() => undefined))!
    for (const hook of mocks.mounted) hook()
    session.imported.value = importSchemeJson(legacy)
    session.modifiedSinceDownload.value = true
    session.modifiedSinceLocalSave.value = true
    await nextTick()
    await vi.advanceTimersByTimeAsync(800)
    expect(session.recoveryStatus.value).toBe('saved')
    expect(mocks.saveRecovery).toHaveBeenCalledOnce()
    // Клик не записывает файл: имитация отменённой/заблокированной браузером загрузки.
    session.saveV5()
    await nextTick()
    await vi.advanceTimersByTimeAsync(800)
    expect(mocks.click).toHaveBeenCalledOnce()
    expect(session.hasUnsavedWork.value).toBe(true)
    expect(mocks.deleteRecovery).not.toHaveBeenCalled()
    const preventDefault = vi.fn()
    listeners.get('beforeunload')!({ preventDefault })
    expect(preventDefault).toHaveBeenCalledOnce()
    await session.saveLocally()
    await nextTick()
    expect(session.hasUnsavedWork.value).toBe(false)
    expect(mocks.deleteRecovery).toHaveBeenCalled()
    preventDefault.mockClear()
    listeners.get('beforeunload')!({ preventDefault })
    expect(preventDefault).not.toHaveBeenCalled()
  })
})
