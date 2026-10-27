import { createRenderer, defineComponent, nextTick, ref, shallowRef } from 'vue'
import { createPinia, setActivePinia, storeToRefs, type Pinia } from 'pinia'
import { useEditorNavigationStore } from '../../stores/editor-navigation'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { importSchemeJson, type ImportResult } from '../../domain/import'
import type { ProjectSummary } from '../../domain/local-projects'
import raw from '../../../tests/fixtures/manual-v1.json?raw'
import { useEditorNavigation } from '../useEditorNavigation'

const local = vi.hoisted(() => ({ listLocalProjects: vi.fn<() => Promise<ProjectSummary[]>>() }))
vi.mock('../../services/local-projects', () => local)

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
beforeEach(() => local.listLocalProjects.mockReset().mockResolvedValue([]))
afterEach(() => {
  unmount?.()
  setActivePinia(undefined)
})
function mount(pinia: Pinia = createPinia()) {
  const imported = shallowRef<ImportResult | null>(null)
  const placementDirty = ref(false)
  let navigation!: ReturnType<typeof useEditorNavigation>
  const app = renderer.createApp(
    defineComponent({
      setup() {
        const state = storeToRefs(useEditorNavigationStore())
        navigation = useEditorNavigation({ imported, placementDirty }, state)
        return () => null
      },
    }),
  )
  app.use(pinia)
  app.mount({ children: [] })
  unmount = () => app.unmount()
  return { navigation, imported, placementDirty, app, pinia }
}
const project = { id: '11111111-1111-4111-8111-111111111111' } as ProjectSummary

describe('editor navigation lifecycle', () => {
  it('shares navigation with readers without resetting context or loading projects again', async () => {
    const { navigation: nav, app } = mount()
    nav.showView('registries')
    nav.registryTab.value = 'parameters'
    nav.openHelp()
    nav.chooseProjectTab('file')
    const reader = app.runWithContext(() => storeToRefs(useEditorNavigationStore()))
    expect(reader.activeView.value).toBe('help')
    expect(reader.registryTab.value).toBe('parameters')
    expect(reader.helpSection.value).toBe('parameters')
    expect(reader.helpOpenKey.value).toBe(1)
    expect(reader.projectTab.value).toBe('file')
    expect(reader.projectTabChosen.value).toBe(true)
    expect(local.listLocalProjects).toHaveBeenCalledTimes(1)
    expect(Object.keys(nav).sort()).toEqual([
      'activeView',
      'chooseProjectTab',
      'findingNotice',
      'helpOpenKey',
      'helpSection',
      'navigateToFinding',
      'openHelp',
      'openMyProjects',
      'openSetupImport',
      'projectTab',
      'registriesVisited',
      'registryTab',
      'showView',
    ])
    await nextTick()
    expect(reader.projectTab.value).toBe('file')
  })

  it('keeps a late startup response attached to its explicit app refs', async () => {
    let resolve!: (projects: ProjectSummary[]) => void
    const response = new Promise<ProjectSummary[]>((yes) => {
      resolve = yes
    })
    local.listLocalProjects.mockReturnValueOnce(response)
    const { navigation: nav } = mount()
    const other = useEditorNavigationStore(createPinia())
    other.projectTab = 'file'
    other.projectTabChosen = true
    setActivePinia(createPinia())
    resolve([project])
    await response
    await nextTick()
    expect(nav.projectTab.value).toBe('local')
    expect(other.projectTab).toBe('file')
    expect(other.activeView).toBe('projects')
  })

  it('allows general screens without a project and leaves the open document untouched', async () => {
    const { navigation: nav, imported } = mount()
    for (const view of ['source', 'geometry', 'objects', 'review'] as const) nav.showView(view)
    expect(nav.activeView.value).toBe('projects')
    nav.showView('registries')
    expect(nav.registriesVisited.value).toBe(true)
    imported.value = importSchemeJson(raw)
    const opened = imported.value
    nav.showView('geometry')
    nav.openMyProjects()
    nav.openHelp()
    nav.showView('objects')
    expect(imported.value).toBe(opened)
    expect(nav.activeView.value).toBe('objects')
    await nextTick()
  })

  it('a late startup list never overrides a tab chosen by the user', async () => {
    let resolve!: (projects: ProjectSummary[]) => void
    const response = new Promise<ProjectSummary[]>((yes) => {
      resolve = yes
    })
    local.listLocalProjects.mockReturnValue(response)
    const { navigation: nav } = mount()
    nav.chooseProjectTab('file')
    resolve([project])
    await response
    await nextTick()
    expect(nav.projectTab.value).toBe('file')
  })

  it('opens saved projects at startup, and keeps the new tab if the database is unavailable', async () => {
    local.listLocalProjects.mockResolvedValueOnce([project])
    const first = mount()
    await nextTick()
    expect(first.navigation.projectTab.value).toBe('local')
    unmount()
    local.listLocalProjects.mockRejectedValueOnce(new Error('offline'))
    const second = mount()
    await nextTick()
    expect(second.navigation.projectTab.value).toBe('new')
  })

  it('keeps help context when reopened and clears a blocked finding notice after applying an object', async () => {
    const { navigation: nav, placementDirty } = mount()
    nav.showView('registries')
    nav.registryTab.value = 'parameters'
    nav.openHelp()
    expect(nav.helpSection.value).toBe('parameters')
    const key = nav.helpOpenKey.value
    nav.openHelp()
    expect(nav.helpSection.value).toBe('parameters')
    expect(nav.helpOpenKey.value).toBe(key + 1)
    nav.openHelp('first-run')
    expect(nav.helpSection.value).toBe('first-run')
    placementDirty.value = true
    await nextTick()
    nav.findingNotice.value = 'Завершите правку объекта'
    placementDirty.value = false
    await nextTick()
    expect(nav.findingNotice.value).toBe('')
  })
})
