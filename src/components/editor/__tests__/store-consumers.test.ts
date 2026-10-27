import { createRenderer, nextTick, type Component } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import ProjectHub from '../ProjectHub.vue'
import RegistryHub from '../RegistryHub.vue'
import EditorWorkspace from '../EditorWorkspace.vue'
import { useProjectDocumentStore } from '../../../stores/project-document'
import { useProjectSessionUiStore } from '../../../stores/project-session-ui'
import { useEditorNavigationStore } from '../../../stores/editor-navigation'
import { useCatalogRefreshStore } from '../../../stores/catalog-refresh'
import { useProjectSession } from '../../../composables/useProjectSession'
import { createRecoveryRepository } from '../../../services/local-projects'
import { importSchemeJson } from '../../../domain/import'
import { createSchemeDetailsDraft } from '../../../domain/edit-details'
import { usedSignCodes } from '../../../domain/sign-images'
import raw from '../../../../tests/fixtures/manual-v1.json?raw'

// Exercise the real parent SFCs; leaf forms/catalogs keep their own contracts and workflows.
const leaves = vi.hoisted(() => {
  type Capture = { props: Record<string, unknown>; emit(event: string, ...args: unknown[]): void }
  const captures: Record<string, Capture[]> = {}
  return {
    captures,
    last(name: string) {
      return captures[name]!.at(-1)!
    },
    component(name: string) {
      return {
        name,
        props: [
          'scheme',
          'active',
          'locked',
          'refreshKey',
          'activeId',
          'activeRevision',
          'selectedId',
          'selectedPlacementId',
          'recovery',
          'mode',
          'view',
          'referencedSignIds',
        ],
        setup(props: Record<string, unknown>, { emit }: Pick<Capture, 'emit'>) {
          ;(captures[name] ??= []).push({ props, emit })
          return () => null
        },
      }
    },
  }
})
vi.mock('../../NewScheme.vue', () => ({ default: leaves.component('NewScheme') }))
vi.mock('../../LocalProjects.vue', () => ({ default: leaves.component('LocalProjects') }))
vi.mock('../../FirstRunWizard.vue', () => ({ default: leaves.component('FirstRunWizard') }))
vi.mock('../../DiagnosticsPanel.vue', () => ({ default: leaves.component('DiagnosticsPanel') }))
vi.mock('../../LocalRegistries.vue', () => ({ default: leaves.component('LocalRegistries') }))
vi.mock('../../ImportedData.vue', () => ({ default: leaves.component('ImportedData') }))
vi.mock('../../NormativeDocuments.vue', () => ({ default: leaves.component('NormativeDocuments') }))
vi.mock('../../NormativeParameters.vue', () => ({
  default: leaves.component('NormativeParameters'),
}))
vi.mock('../../Pu66Lifecycle.vue', () => ({ default: leaves.component('Pu66Lifecycle') }))
vi.mock('../../Pu66Linker.vue', () => ({ default: leaves.component('Pu66Linker') }))
vi.mock('../../TemplateChoice.vue', () => ({ default: leaves.component('TemplateChoice') }))
vi.mock('../../SchemeWorkspace.vue', () => ({ default: leaves.component('SchemeWorkspace') }))
vi.mock('../../PlacementEditor.vue', () => ({ default: leaves.component('PlacementEditor') }))
vi.mock('../../SchemeReview.vue', () => ({ default: leaves.component('SchemeReview') }))
vi.mock('../../SchemeDetailsEditor.vue', () => ({
  default: leaves.component('SchemeDetailsEditor'),
}))
vi.mock('../../SchemeDraftSheet.vue', () => ({ default: leaves.component('SchemeDraftSheet') }))
vi.mock('../../ProjectDataInspector.vue', () => ({
  default: leaves.component('ProjectDataInspector'),
}))
vi.mock('../../../composables/useProjectSession', () => ({
  useProjectSession: vi.fn(() => {
    throw new Error('A view must not create a session')
  }),
}))
vi.mock('../../../services/local-projects', () => ({ createRecoveryRepository: vi.fn() }))

type Host = { children: Host[]; parent: Host | null; style: { display: string } }
const host = (): Host => ({ children: [], parent: null, style: { display: '' } })
const renderer = createRenderer<Host, Host>({
  createElement: host,
  createText: host,
  createComment: host,
  insert(node, parent, anchor) {
    if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1)
    node.parent = parent
    const index = anchor ? parent.children.indexOf(anchor) : -1
    if (index < 0) parent.children.push(node)
    else parent.children.splice(index, 0, node)
  },
  remove(node) {
    if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1)
    node.parent = null
  },
  setText: () => undefined,
  setElementText: () => undefined,
  patchProp: () => undefined,
  parentNode: (node) => node.parent,
  nextSibling: (node) => node.parent?.children[node.parent.children.indexOf(node) + 1] ?? null,
})
const cleanups: Array<() => void> = []
beforeEach(() => {
  vi.clearAllMocks()
  for (const key of Object.keys(leaves.captures)) delete leaves.captures[key]
  vi.stubGlobal('fetch', vi.fn())
})
afterEach(() => {
  cleanups.splice(0).forEach((stop) => stop())
  setActivePinia(undefined)
  vi.unstubAllGlobals()
})
function mount(component: Component, props: Record<string, unknown>, pinia = createPinia()) {
  const app = renderer.createApp(component, props)
  app.use(pinia)
  app.mount(host())
  cleanups.push(() => app.unmount())
}
function state() {
  const pinia = createPinia()
  const document = useProjectDocumentStore(pinia)
  document.imported = importSchemeJson(raw)
  return {
    pinia,
    document,
    ui: useProjectSessionUiStore(pinia),
    navigation: useEditorNavigationStore(pinia),
    refresh: useCatalogRefreshStore(pinia),
  }
}
function expectNoSession() {
  expect(useProjectSession).not.toHaveBeenCalled()
  expect(createRecoveryRepository).not.toHaveBeenCalled()
  expect(fetch).not.toHaveBeenCalled()
}
const projectCommands = () => ({
  openRecovery: vi.fn(),
  discardRecovery: vi.fn(),
  createProject: vi.fn(),
  openLocal: vi.fn(),
  restoreLocal: vi.fn(),
  onFileSelected: vi.fn(),
})
const editorCommands = () => ({
  saveAsNew: vi.fn(),
  exportCurrentProject: vi.fn(),
  exportOriginalProject: vi.fn(),
  stepBack: vi.fn(),
  stepForward: vi.fn(),
  onPu66Linked: vi.fn(),
  buildDraftTemplate: vi.fn(),
  pinCurrentSigns: vi.fn(),
  onProjectApplied: vi.fn(),
  onDetailsApplied: vi.fn(),
})

it('reads live project data and navigation, forwarding create to the root command port', async () => {
  const { pinia, document, ui, navigation } = state()
  const commands = projectCommands()
  document.localRevision = 4
  ui.localBusy = true
  ui.activeRecoveryId = 'existing-recovery'
  navigation.projectTab = 'local'
  mount(ProjectHub, { commands, setupStatus: null, setupError: '' }, pinia)
  expect(leaves.last('LocalProjects').props).toMatchObject({
    activeId: document.imported!.scheme.id,
    activeRevision: 4,
    locked: true,
  })
  ui.localBusy = false
  document.localRevision = 5
  navigation.projectTab = 'new'
  navigation.activeView = 'geometry'
  await nextTick()
  expect(leaves.last('NewScheme').props).toMatchObject({ locked: false, active: false })
  leaves.last('NewScheme').emit('create', document.imported!.scheme)
  expect(commands.createProject).toHaveBeenCalledWith(document.imported!.scheme)
  expect(ui.activeRecoveryId).toBe('existing-recovery')
  expectNoSession()
})

it('keeps mounted readers of the same project isolated between apps after active Pinia changes', async () => {
  const first = state()
  first.document.localRevision = 1
  first.navigation.projectTab = 'local'
  mount(ProjectHub, { commands: projectCommands(), setupStatus: null, setupError: '' }, first.pinia)
  const firstReader = leaves.last('LocalProjects')
  const second = state()
  second.document.imported = first.document.imported
  second.document.localRevision = 9
  second.navigation.projectTab = 'local'
  mount(
    ProjectHub,
    { commands: projectCommands(), setupStatus: null, setupError: '' },
    second.pinia,
  )
  const secondReader = leaves.last('LocalProjects')
  setActivePinia(createPinia())
  await Promise.resolve()
  first.document.localRevision = 2
  first.ui.localBusy = true
  await nextTick()
  expect(firstReader.props).toMatchObject({ activeRevision: 2, locked: true })
  expect(secondReader.props).toMatchObject({ activeRevision: 9, locked: false })
  expect(firstReader.props.activeId).toBe(secondReader.props.activeId)
  expectNoSession()
})

it('keeps pending form objects in the shared document and delegates applied edits', async () => {
  const { pinia, document, ui, navigation, refresh } = state()
  const commands = editorCommands()
  navigation.activeView = 'geometry'
  mount(EditorWorkspace, { commands }, pinia)
  const details = leaves.last('SchemeDetailsEditor')
  expect(details.props.scheme).toBe(document.imported!.scheme)
  expect(details.props.mode).toBe('geometry')
  const draft = createSchemeDetailsDraft(document.imported!.scheme)
  details.emit('dirty', true)
  details.emit('draft', draft)
  await nextTick()
  expect(document.detailsDirty).toBe(true)
  expect(document.pendingDetails).toBe(draft)
  expect(leaves.last('PlacementEditor').props.locked).toBe(true)
  const applied = { ...document.imported!.scheme }
  details.emit('apply', applied)
  expect(commands.onDetailsApplied).toHaveBeenCalledWith(applied)
  ui.localBusy = true
  navigation.activeView = 'source'
  refresh.signCatalogVersion++
  await nextTick()
  expect(details.props.mode).toBe('source')
  expect(details.props.locked).toBe(true)
  expect(document.pendingDetails).toBe(draft)
  expectNoSession()
})

it('reads registry locks, referenced signs and diagnostics directly from the same app stores', async () => {
  const { pinia, document, ui, navigation, refresh } = state()
  document.detailsDirty = true
  refresh.signCatalogVersion = 2
  refresh.pu66CatalogVersion = 3
  mount(RegistryHub, {}, pinia)
  expect(leaves.last('ImportedData').props).toMatchObject({ locked: true, refreshKey: 5 })
  expect(leaves.last('ImportedData').props.referencedSignIds).toEqual(
    usedSignCodes(document.imported!.scheme),
  )
  navigation.registryTab = 'diagnostics'
  navigation.activeView = 'registries'
  ui.localBusy = true
  document.imported = { ...document.imported!, scheme: { ...document.imported!.scheme } }
  refresh.pu66CatalogVersion++
  await nextTick()
  expect(leaves.last('DiagnosticsPanel').props.scheme).toBe(document.imported!.scheme)
  expect(leaves.last('DiagnosticsPanel').props.view).toBe('registries')
  expect(leaves.last('Pu66Lifecycle').props.locked).toBe(true)
  expect(leaves.last('ImportedData').props.refreshKey).toBe(6)
  expectNoSession()
})
