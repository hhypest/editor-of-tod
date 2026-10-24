import { onMounted, onUnmounted } from 'vue'

export interface BrowserLifecycleHandlers {
  start(): void
  stop(): void
  beforeUnload(event: BeforeUnloadEvent): void
  pageHide(): void
  visible(): void
}

/** Browser listeners belong to the mounted window, not to document or persistence workflows. */
export function useBrowserLifecycle(handlers: BrowserLifecycleHandlers): void {
  function onVisible(): void {
    if (document.visibilityState === 'visible') handlers.visible()
  }
  onMounted(() => {
    window.addEventListener('beforeunload', handlers.beforeUnload)
    window.addEventListener('pagehide', handlers.pageHide)
    window.addEventListener('pageshow', onVisible)
    document.addEventListener('visibilitychange', onVisible)
    handlers.start()
  })
  onUnmounted(() => {
    window.removeEventListener('beforeunload', handlers.beforeUnload)
    window.removeEventListener('pagehide', handlers.pageHide)
    window.removeEventListener('pageshow', onVisible)
    document.removeEventListener('visibilitychange', onVisible)
    handlers.stop()
  })
}
