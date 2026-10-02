import { createRenderer, defineComponent, nextTick } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import raw from '../../../tests/fixtures/manual-v1.json?raw'
import { useProjectSession } from '../useProjectSession'

const local = vi.hoisted(() => ({
  listRecoveryDrafts: vi.fn(async () => []),
  saveRecoveryDraft: vi.fn(async () => ({ version: 1 })),
  deleteRecoveryDraft: vi.fn(async () => undefined),
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
  vi.stubGlobal('window', Object.assign(new EventTarget(), { setTimeout }))
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
