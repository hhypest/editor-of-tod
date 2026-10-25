import { createRenderer, defineComponent, effectScope, ref } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useBrowserLifecycle } from '../useBrowserLifecycle'
import { useSessionCursor } from '../useSessionCursor'
import { revisionDelivery } from '../../application/project-revisions'

afterEach(() => vi.unstubAllGlobals())

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

describe('window lifecycle and synchronous session identity', () => {
  it('subscribes once, renews only while visible and removes every listener on unmount', () => {
    const windowTarget = new EventTarget()
    const documentTarget = Object.assign(new EventTarget(), { visibilityState: 'hidden' })
    vi.stubGlobal('window', windowTarget)
    vi.stubGlobal('document', documentTarget)
    const handlers = {
      start: vi.fn(),
      stop: vi.fn(),
      beforeUnload: vi.fn(),
      pageHide: vi.fn(),
      visible: vi.fn(),
    }
    const app = renderer.createApp(
      defineComponent({
        setup() {
          useBrowserLifecycle(handlers)
          return () => null
        },
      }),
    )
    app.mount({ children: [] })
    try {
      windowTarget.dispatchEvent(new Event('pageshow'))
      windowTarget.dispatchEvent(new Event('focus'))
      windowTarget.dispatchEvent(new Event('online'))
      documentTarget.dispatchEvent(new Event('visibilitychange'))
      expect(handlers.visible).not.toHaveBeenCalled()
      documentTarget.visibilityState = 'visible'
      windowTarget.dispatchEvent(new Event('pageshow'))
      documentTarget.dispatchEvent(new Event('visibilitychange'))
      windowTarget.dispatchEvent(new Event('beforeunload'))
      windowTarget.dispatchEvent(new Event('pagehide'))
      expect(handlers.start).toHaveBeenCalledTimes(1)
      expect(handlers.visible).toHaveBeenCalledTimes(2)
      windowTarget.dispatchEvent(new Event('focus'))
      windowTarget.dispatchEvent(new Event('online'))
      expect(handlers.visible).toHaveBeenCalledTimes(4)
      expect(handlers.beforeUnload).toHaveBeenCalledTimes(1)
      expect(handlers.pageHide).toHaveBeenCalledTimes(1)
    } finally {
      app.unmount()
    }
    windowTarget.dispatchEvent(new Event('pageshow'))
    windowTarget.dispatchEvent(new Event('focus'))
    windowTarget.dispatchEvent(new Event('online'))
    documentTarget.dispatchEvent(new Event('visibilitychange'))
    windowTarget.dispatchEvent(new Event('beforeunload'))
    windowTarget.dispatchEvent(new Event('pagehide'))
    expect(handlers.stop).toHaveBeenCalledTimes(1)
    expect(handlers.visible).toHaveBeenCalledTimes(4)
    expect(handlers.beforeUnload).toHaveBeenCalledTimes(1)
    expect(handlers.pageHide).toHaveBeenCalledTimes(1)
  })

  it('invalidates a captured response synchronously for input and for reopening the same document', () => {
    const scope = effectScope()
    const input = ref('Прежний ввод')
    const cursor = scope.run(() => useSessionCursor([input]))!
    try {
      const captured = cursor.snapshot()
      input.value = 'Неприменённый ввод до следующего render batch'
      expect(revisionDelivery(captured, cursor.snapshot())).toBe('edited')
      cursor.begin()
      expect(revisionDelivery(captured, cursor.snapshot())).toBe('switched')
    } finally {
      scope.stop()
    }
  })
})
