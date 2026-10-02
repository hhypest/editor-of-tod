import { createRenderer, defineComponent, nextTick } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import raw from '../../../tests/fixtures/manual-v1.json?raw'
import { useProjectSession } from '../useProjectSession'

const local = vi.hoisted(() => ({
  listRecoveryDrafts: vi.fn(async () => []),
  saveRecoveryDraft: vi.fn(async () => ({ version: 1 })),
  deleteRecoveryDraft: vi.fn(async () => undefined),
}))
vi.mock('../../services/local-projects', () => local)
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
  vi.stubGlobal('window', Object.assign(new EventTarget(), { setTimeout }))
  vi.stubGlobal('document', {
    body: { append: vi.fn() },
    createElement: () => ({ click: vi.fn(), remove: vi.fn() }),
  })
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
})
