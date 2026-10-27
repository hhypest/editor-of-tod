import { createApp } from 'vue'
import { createPinia, setActivePinia, storeToRefs } from 'pinia'
import { afterEach, expect, it, vi } from 'vitest'
import { useProjectSessionUiStore } from '../../stores/project-session-ui'

afterEach(() => {
  setActivePinia(undefined)
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

it('creates and reads the projection without HTTP, listeners, timers or a recovery id', () => {
  vi.useFakeTimers()
  const fetch = vi.fn()
  const addEventListener = vi.fn()
  vi.stubGlobal('fetch', fetch)
  vi.stubGlobal('window', { addEventListener })
  vi.stubGlobal('document', { addEventListener })
  const pinia = createPinia()
  const state = storeToRefs(useProjectSessionUiStore(pinia))
  expect(state.activeRecoveryId.value).toBe('')
  expect(state.recoveryStatus.value).toBe('idle')
  expect(state.recoveryCopies.value).toEqual([])
  expect(fetch).not.toHaveBeenCalled()
  expect(addEventListener).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})

it('shares all feedback between app readers and isolates other apps after await', async () => {
  const first = createApp({ render: () => null }).use(createPinia())
  const second = createApp({ render: () => null }).use(createPinia())
  const owner = first.runWithContext(() => useProjectSessionUiStore())
  const reader = first.runWithContext(() => storeToRefs(useProjectSessionUiStore()))
  const other = second.runWithContext(() => useProjectSessionUiStore())
  const initial = { ...other.$state }
  await Promise.resolve()
  setActivePinia(createPinia())
  owner.$patch({
    localBusy: true,
    localError: 'Учебная ошибка',
    localNotice: 'Учебное сообщение',
    projectsRefreshKey: 3,
    templateMessage: 'Шаблон обновлён',
    templateError: 'Учебная ошибка шаблона',
    signPinMessage: 'Учебный результат PNG',
    recoveryCopies: [],
    recoveryStatus: 'error',
    activeRecoveryId: 'same-id',
  })
  for (const key of Object.keys(reader) as Array<keyof typeof reader>) {
    expect(reader[key].value).toEqual(owner[key])
  }
  const laterReader = first.runWithContext(() => useProjectSessionUiStore())
  expect(laterReader).toBe(owner)
  expect(laterReader.activeRecoveryId).toBe('same-id')
  expect(laterReader.recoveryStatus).toBe('error')
  expect(other.$state).toEqual(initial)
  other.activeRecoveryId = 'same-id'
  other.recoveryStatus = 'saved'
  expect(reader.recoveryStatus.value).toBe('error')
})
