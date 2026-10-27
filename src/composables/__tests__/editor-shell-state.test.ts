import { createApp } from 'vue'
import { createPinia, setActivePinia, storeToRefs } from 'pinia'
import { afterEach, expect, it, vi } from 'vitest'
import { useEditorNavigationStore } from '../../stores/editor-navigation'
import { useCatalogRefreshStore } from '../../stores/catalog-refresh'

afterEach(() => {
  setActivePinia(undefined)
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

it('reads navigation and refresh data without HTTP, browser access or timers', () => {
  vi.useFakeTimers()
  const fetch = vi.fn()
  const addEventListener = vi.fn()
  const querySelectorAll = vi.fn()
  vi.stubGlobal('fetch', fetch)
  vi.stubGlobal('window', { addEventListener })
  vi.stubGlobal('document', { addEventListener, querySelectorAll })
  const pinia = createPinia()
  const navigation = useEditorNavigationStore(pinia)
  const refresh = useCatalogRefreshStore(pinia)
  storeToRefs(navigation)
  storeToRefs(refresh)
  expect(navigation.activeView).toBe('projects')
  expect(navigation.projectTab).toBe('new')
  expect(navigation.registryTab).toBe('imports')
  expect(navigation.projectTabChosen).toBe(false)
  expect(refresh.signCatalogVersion).toBe(0)
  expect(refresh.pu66CatalogVersion).toBe(0)
  expect(fetch).not.toHaveBeenCalled()
  expect(addEventListener).not.toHaveBeenCalled()
  expect(querySelectorAll).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})

it('shares shell data inside an app and isolates a second app across await', async () => {
  const first = createApp({ render: () => null }).use(createPinia())
  const second = createApp({ render: () => null }).use(createPinia())
  const owner = first.runWithContext(() => useEditorNavigationStore())
  const refresh = first.runWithContext(() => useCatalogRefreshStore())
  const reader = first.runWithContext(() => storeToRefs(useEditorNavigationStore()))
  const refreshReader = first.runWithContext(() => storeToRefs(useCatalogRefreshStore()))
  const other = second.runWithContext(() => useEditorNavigationStore())
  const otherRefresh = second.runWithContext(() => useCatalogRefreshStore())
  await Promise.resolve()
  setActivePinia(createPinia())
  owner.$patch({
    activeView: 'help',
    projectTab: 'local',
    registryTab: 'parameters',
    registriesVisited: true,
    projectTabChosen: true,
    helpSection: 'parameters',
    helpOpenKey: 2,
    findingNotice: 'Учебное сообщение',
  })
  refresh.signCatalogVersion++
  refresh.pu66CatalogVersion += 2
  for (const key of Object.keys(reader) as Array<keyof typeof reader>) {
    expect(reader[key].value).toEqual(owner[key])
  }
  expect(first.runWithContext(() => useEditorNavigationStore())).toBe(owner)
  expect(refreshReader.signCatalogVersion.value).toBe(1)
  expect(refreshReader.pu66CatalogVersion.value).toBe(2)
  expect(other.activeView).toBe('projects')
  expect(other.projectTab).toBe('new')
  expect(other.registryTab).toBe('imports')
  expect(other.registriesVisited).toBe(false)
  expect(other.projectTabChosen).toBe(false)
  expect(other.helpSection).toBeNull()
  expect(other.helpOpenKey).toBe(0)
  expect(other.findingNotice).toBe('')
  expect(otherRefresh.signCatalogVersion).toBe(0)
  expect(otherRefresh.pu66CatalogVersion).toBe(0)
})
