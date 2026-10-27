import { createRenderer, defineComponent, h, nextTick, ref, type Ref } from 'vue'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { pu66StatusSchema, type Pu66Status } from '../../domain/pu66-lifecycle'
import { invalidatePu66Status, usePu66Status, usePu66StatusInvalidation } from '../usePu66Status'

const api = vi.hoisted(() => ({ get: vi.fn<(key: string) => Promise<Pu66Status>>() }))
vi.mock('../../services/local-pu66', () => ({ getPu66Status: api.get }))

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
const roots = new Set<() => void>()
let namespace = 0
let windowTarget: EventTarget
beforeEach(() => {
  namespace++
  api.get.mockReset().mockImplementation(async (key) => active(key))
  windowTarget = new EventTarget()
  vi.stubGlobal('window', windowTarget)
})
afterEach(() => {
  for (const dispose of roots) dispose()
  setActivePinia(undefined)
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('PU-66 status ownership after the Pinia transfer (#191)', () => {
  it('isolates the same key, in-flight requests, cached data and failure between apps', async () => {
    const id = key('same-key-in-two-apps')
    const firstResponse = deferred<Pu66Status>()
    const secondResponse = deferred<Pu66Status>()
    api.get.mockReturnValueOnce(firstResponse.promise).mockReturnValueOnce(secondResponse.promise)
    const first = mount([ref(id)]).views[0]!
    const second = mount([ref(id)]).views[0]!
    const firstReload = first.reload()
    const secondReload = second.reload()
    expect(api.get).toHaveBeenCalledTimes(2)
    firstResponse.resolve(excluded(id))
    await firstReload
    expect(first.status.value).toEqual(excluded(id))
    expect(second.status.value).toBeNull()
    expect(second.loading.value).toBe(true)
    secondResponse.reject(new Error('Учебный отказ второго окна'))
    await secondReload
    expect(second.unavailable.value).toBe(true)
    expect(second.findings.value[0]?.markBlocked).toBeTruthy()
    expect(first.unavailable.value).toBe(false)
    expect(first.findings.value[0]?.title).toBe('Карточка ПУ-66 исключена')
  })

  it('keeps a captured invalidation callback bound to its app after asynchronous work and an active-app switch', async () => {
    const first = mount([ref('')])
    const invalidateFirst = first.app.runWithContext(() => usePu66StatusInvalidation())
    const second = mount([ref('')])
    const invalidateSecond = second.app.runWithContext(() => usePu66StatusInvalidation())
    const firstVersion = first.views[0]!.version.value
    const secondVersion = second.views[0]!.version.value
    await Promise.resolve()
    setActivePinia(second.pinia)
    invalidateFirst()
    await nextTick()
    expect(first.views[0]!.version.value).toBe(firstVersion + 1)
    expect(second.views[0]!.version.value).toBe(secondVersion)
    setActivePinia(first.pinia)
    invalidateSecond()
    expect(second.views[0]!.version.value).toBe(secondVersion + 1)
    expect(first.views[0]!.version.value).toBe(firstVersion + 1)
    // The compatible direct export can also address an explicit app outside setup.
    invalidatePu66Status(first.pinia)
    expect(first.views[0]!.version.value).toBe(firstVersion + 2)
    expect(second.views[0]!.version.value).toBe(secondVersion + 1)
    expect(api.get).not.toHaveBeenCalled()
  })

  it('does not start HTTP or register browser listeners when only creating or invalidating a store', async () => {
    const add = vi.spyOn(windowTarget, 'addEventListener')
    const app = renderer.createApp({ render: () => null }).use(createPinia())
    const invalidate = app.runWithContext(() => usePu66StatusInvalidation())
    expect(api.get).not.toHaveBeenCalled()
    expect(add).not.toHaveBeenCalled()
    invalidate()
    await nextTick()
    expect(api.get).not.toHaveBeenCalled()
    expect(add).not.toHaveBeenCalled()
  })
})

function key(name: string): string {
  return `synthetic-${namespace}-${name}`
}
function active(referenceId: string): Pu66Status {
  return pu66StatusSchema.parse({ referenceId, excluded: false, event: null, successorKey: null })
}
function excluded(referenceId: string): Pu66Status {
  return pu66StatusSchema.parse({
    referenceId,
    excluded: true,
    successorKey: null,
    event: {
      id: 1,
      action: 'exclude',
      date: '2030-01-01',
      actor: 'Учебный составитель',
      reason: 'closed',
      comment: 'Вымышленная карточка для проверки интерфейса',
      successorKey: null,
      cardRevision: 1,
      recordedAt: '2030-01-01T00:00:00.000Z',
    },
  })
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

// Real component scopes exercise immediate watches, app injection and unmount cleanup.
function mount(keys: Ref<string>[], pinia: Pinia = createPinia()) {
  const views: ReturnType<typeof usePu66Status>[] = []
  const visible = ref(keys.map(() => true))
  const children = keys.map((key) =>
    defineComponent({
      setup() {
        views.push(usePu66Status(key))
        return () => null
      },
    }),
  )
  const app = renderer.createApp({
    render: () =>
      h(
        'div',
        children.map((child, i) => (visible.value[i] ? h(child, { key: i }) : null)),
      ),
  })
  app.use(pinia)
  app.mount({ children: [] })
  const dispose = () => {
    app.unmount()
    roots.delete(dispose)
  }
  roots.add(dispose)
  return { app, views, visible, dispose, pinia }
}

describe('PU-66 status contracts captured before the Pinia transfer (#191)', () => {
  it('keeps the six public fields and does not request an empty key', async () => {
    const { views } = mount([ref('')])
    const view = views[0]!
    expect(Object.keys(view).sort()).toEqual([
      'findings',
      'loading',
      'reload',
      'status',
      'unavailable',
      'version',
    ])
    expect(view.status.value).toBeNull()
    expect(view.loading.value).toBe(false)
    expect(view.unavailable.value).toBe(false)
    expect(view.findings.value).toEqual([])
    await view.reload()
    expect(api.get).not.toHaveBeenCalled()
  })

  it('shares one in-flight request across two mounted consumers and explicit reloads', async () => {
    const id = key('shared')
    const response = deferred<Pu66Status>()
    api.get.mockReturnValueOnce(response.promise)
    const { views } = mount([ref(id), ref(id)])
    const first = views[0]!
    const second = views[1]!
    const pending = [first.reload(), second.reload()]
    expect(api.get).toHaveBeenCalledTimes(1)
    expect(first.loading.value).toBe(true)
    expect(second.findings.value[0]?.markBlocked).toBe('Локальный статус карточки недоступен.')
    response.resolve(excluded(id))
    await Promise.all(pending)
    for (const view of views) {
      expect(view.status.value).toEqual(excluded(id))
      expect(view.loading.value).toBe(false)
      expect(view.unavailable.value).toBe(false)
      expect(view.findings.value[0]?.title).toBe('Карточка ПУ-66 исключена')
    }
  })

  it('keeps different keys independent when responses arrive out of order', async () => {
    const a = key('a'),
      b = key('b')
    const firstResponse = deferred<Pu66Status>(),
      secondResponse = deferred<Pu66Status>()
    api.get.mockImplementation((id) => (id === a ? firstResponse.promise : secondResponse.promise))
    const { views } = mount([ref(a), ref(b)])
    const first = views[0]!,
      second = views[1]!
    const firstReload = first.reload(),
      secondReload = second.reload()
    secondResponse.resolve(excluded(b))
    await secondReload
    expect(first.status.value).toBeNull()
    expect(first.loading.value).toBe(true)
    expect(second.status.value).toEqual(excluded(b))
    firstResponse.resolve(active(a))
    await firstReload
    expect(first.status.value).toEqual(active(a))
    expect(second.status.value).toEqual(excluded(b))
    expect(api.get).toHaveBeenCalledTimes(2)
  })

  it('never replaces the selected key with a late response from the previous key', async () => {
    const a = key('old'),
      b = key('current')
    const oldResponse = deferred<Pu66Status>(),
      currentResponse = deferred<Pu66Status>()
    api.get.mockImplementation((id) => (id === a ? oldResponse.promise : currentResponse.promise))
    const selected = ref(a)
    const view = mount([selected]).views[0]!
    const oldReload = view.reload()
    selected.value = b
    await nextTick()
    const currentReload = view.reload()
    expect(view.status.value).toBeNull()
    currentResponse.resolve(active(b))
    await currentReload
    oldResponse.resolve(excluded(a))
    await oldReload
    expect(view.status.value).toEqual(active(b))
    expect(view.findings.value).toEqual([])
    expect(api.get.mock.calls.map(([id]) => id)).toEqual([a, b])
  })

  it('retains cached status on failure, blocks checking, and permits a successful retry', async () => {
    const id = key('retry')
    const view = mount([ref(id)]).views[0]!
    await view.reload()
    api.get.mockRejectedValueOnce(new Error('Учебный отказ'))
    await view.reload()
    expect(view.status.value).toEqual(active(id))
    expect(view.unavailable.value).toBe(true)
    expect(view.loading.value).toBe(false)
    expect(view.findings.value[0]?.markBlocked).toBe('Локальный статус карточки недоступен.')
    const response = deferred<Pu66Status>()
    api.get.mockReturnValueOnce(response.promise)
    const retry = view.reload()
    expect(view.unavailable.value).toBe(true)
    expect(view.loading.value).toBe(true)
    response.resolve(excluded(id))
    await retry
    expect(view.unavailable.value).toBe(false)
    expect(view.loading.value).toBe(false)
    expect(view.status.value).toEqual(excluded(id))
    expect(view.findings.value[0]?.title).toBe('Карточка ПУ-66 исключена')
    expect(api.get).toHaveBeenCalledTimes(3)
  })

  it('rereads after invalidations during a request and keeps checking blocked until fresh data', async () => {
    const id = key('invalidate')
    const oldResponse = deferred<Pu66Status>(),
      freshResponse = deferred<Pu66Status>()
    api.get.mockReturnValueOnce(oldResponse.promise).mockReturnValueOnce(freshResponse.promise)
    const { app, views } = mount([ref(id), ref(id)])
    const first = views[0]!,
      second = views[1]!
    const pending = first.reload()
    const version = first.version.value
    app.runWithContext(() => {
      invalidatePu66Status()
      invalidatePu66Status()
    })
    await nextTick()
    expect(first.version.value).toBe(version + 2)
    expect(api.get).toHaveBeenCalledTimes(1)
    oldResponse.resolve(active(id))
    await nextTick()
    expect(api.get).toHaveBeenCalledTimes(2)
    expect(second.loading.value).toBe(true)
    expect(second.findings.value[0]?.markBlocked).toBe('Локальный статус карточки недоступен.')
    freshResponse.resolve(excluded(id))
    await pending
    expect(first.loading.value).toBe(false)
    expect(second.status.value).toEqual(excluded(id))
    expect(second.findings.value[0]?.markBlocked).toBeUndefined()
  })

  it('also rereads a failed stale request after invalidation without a false successful check', async () => {
    const id = key('invalidate-failure')
    const oldResponse = deferred<Pu66Status>(),
      freshResponse = deferred<Pu66Status>()
    api.get.mockReturnValueOnce(oldResponse.promise).mockReturnValueOnce(freshResponse.promise)
    const { app, views } = mount([ref(id)])
    const view = views[0]!
    const pending = view.reload()
    app.runWithContext(() => invalidatePu66Status())
    await nextTick()
    oldResponse.reject(new Error('Учебный отказ старого чтения'))
    await nextTick()
    expect(api.get).toHaveBeenCalledTimes(2)
    expect(view.loading.value).toBe(true)
    expect(view.unavailable.value).toBe(true)
    expect(view.findings.value[0]?.markBlocked).toBeTruthy()
    freshResponse.resolve(active(id))
    await pending
    expect(view.loading.value).toBe(false)
    expect(view.unavailable.value).toBe(false)
    expect(view.findings.value).toEqual([])
  })

  it('removes only the unmounted consumer listener while the other consumer keeps working', async () => {
    const add = vi.spyOn(windowTarget, 'addEventListener')
    const remove = vi.spyOn(windowTarget, 'removeEventListener')
    const id = key('partial-unmount')
    const { views, visible } = mount([ref(id), ref(id)])
    await views[1]!.reload()
    expect(add).toHaveBeenCalledTimes(2)
    visible.value[0] = false
    await nextTick()
    expect(remove).toHaveBeenCalledTimes(1)
    expect(remove.mock.calls[0]?.[1]).toBe(add.mock.calls[0]?.[1])
    const response = deferred<Pu66Status>()
    api.get.mockReturnValueOnce(response.promise)
    windowTarget.dispatchEvent(new Event('focus'))
    const pending = views[1]!.reload()
    expect(api.get).toHaveBeenCalledTimes(2)
    response.resolve(excluded(id))
    await pending
    expect(views[1]!.status.value).toEqual(excluded(id))
  })

  it('removes focus and key/version watchers on unmount while an existing request can finish', async () => {
    const add = vi.spyOn(windowTarget, 'addEventListener')
    const remove = vi.spyOn(windowTarget, 'removeEventListener')
    const id = key('unmount')
    const response = deferred<Pu66Status>()
    api.get.mockReturnValueOnce(response.promise)
    const selected = ref(id)
    const { app, views, dispose } = mount([selected])
    const pending = views[0]!.reload()
    dispose()
    expect(remove.mock.calls).toEqual(add.mock.calls)
    windowTarget.dispatchEvent(new Event('focus'))
    selected.value = key('after-unmount')
    await nextTick()
    expect(api.get).toHaveBeenCalledTimes(1)
    response.resolve(active(id))
    await pending
    const calls = api.get.mock.calls.length
    app.runWithContext(() => invalidatePu66Status())
    await nextTick()
    windowTarget.dispatchEvent(new Event('focus'))
    expect(api.get).toHaveBeenCalledTimes(calls)
  })
})
