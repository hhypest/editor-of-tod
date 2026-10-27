import { defineStore, type storeToRefs } from 'pinia'
import { ref } from 'vue'
import type { EditorView, ProjectTab, RegistryTab } from '../presentation/editor-navigation'

/** Shared navigation data; startup, DOM focus/scroll and watchers belong to the root adapter. */
export const useEditorNavigationStore = defineStore('editorNavigation', () => {
  const activeView = ref<EditorView>('projects')
  const projectTab = ref<ProjectTab>('new')
  const registryTab = ref<RegistryTab>('imports')
  const registriesVisited = ref(false)
  /** A late startup response must respect the user's chosen tab across all readers. */
  const projectTabChosen = ref(false)
  const helpSection = ref<string | null>(null)
  const helpOpenKey = ref(0)
  const findingNotice = ref('')

  return {
    activeView,
    projectTab,
    registryTab,
    registriesVisited,
    projectTabChosen,
    helpSection,
    helpOpenKey,
    findingNotice,
  }
})

export type EditorNavigationRefs = ReturnType<
  typeof storeToRefs<ReturnType<typeof useEditorNavigationStore>>
>
