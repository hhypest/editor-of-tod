import { nextTick, onMounted, ref, watch, type Ref } from 'vue'
import type { ImportResult } from '../domain/import'
import type { ReviewFinding } from '../domain/review-scheme'
import { mapReviewTarget } from '../presentation/review/map-review-target'
import {
  editorStages,
  type EditorView,
  type ProjectTab,
  type RegistryTab,
  type SetupImportTarget,
} from '../presentation/editor-navigation'
import { helpSectionFor } from '../help/help-content'
import { listLocalProjects } from '../services/local-projects'

/** Navigation changes visibility; it never opens or disposes a project session. */
export function useEditorNavigation({
  imported,
  placementDirty,
}: {
  imported: Readonly<Ref<ImportResult | null>>
  placementDirty: Readonly<Ref<boolean>>
}) {
  const activeView = ref<EditorView>('projects')
  const projectTab = ref<ProjectTab>('new')
  const registryTab = ref<RegistryTab>('imports')
  const registriesVisited = ref(false)
  /** Вкладку выбрал сам составитель — после этого стартовая вкладка не переключается. */
  const projectTabChosen = ref(false)
  function chooseProjectTab(tab: ProjectTab): void {
    projectTab.value = tab
    projectTabChosen.value = true
  }

  function openMyProjects(): void {
    chooseProjectTab('local')
    showView('projects')
  }

  /** При запуске открываем «Мои проекты», если на компьютере уже есть сохранённые проекты. */
  async function chooseStartTab(): Promise<void> {
    try {
      const projects = await listLocalProjects()
      if (projects.length && !projectTabChosen.value) projectTab.value = 'local'
    } catch {
      // Без локальной базы остаётся «Новый проект»: там показана причина.
    }
  }
  const helpSection = ref<string | null>(null)
  const helpOpenKey = ref(0)

  /** Справка по экрану, с которого её открыли. */
  function openHelp(section?: string): void {
    if (activeView.value !== 'help')
      helpSection.value = section ?? helpSectionFor(activeView.value, registryTab.value)
    else if (section) helpSection.value = section
    helpOpenKey.value++
    activeView.value = 'help'
  }

  function showView(view: EditorView): void {
    if (!imported.value && editorStages.includes(view as (typeof editorStages)[number])) return
    if (view === 'registries') registriesVisited.value = true
    activeView.value = view
  }

  /** Пояснение, почему «Перейти» не смог поставить курсор в поле. */
  const findingNotice = ref('')
  watch(placementDirty, (dirty) => {
    if (!dirty) findingNotice.value = ''
  })

  async function navigateToFinding(finding: ReviewFinding): Promise<void> {
    findingNotice.value = ''
    const target = mapReviewTarget(finding)
    if (target.registryTab) registryTab.value = target.registryTab
    showView(target.view)
    await nextTick()
    const field = target.field
      ? [...document.querySelectorAll<HTMLElement>('[data-field]')].find(
          (element) => element.dataset.field === target.field && element.offsetParent !== null,
        )
      : undefined
    if (field?.matches(':disabled')) {
      // Форма заблокирована незавершённой правкой объекта или записью в базу: курсор не встанет.
      if (placementDirty.value) {
        showView('objects')
        await nextTick()
        document.getElementById('placements-title')?.scrollIntoView({ block: 'start' })
        findingNotice.value = `«${finding.title}»: поле станет доступно после того, как правка объекта будет применена или отменена. Завершите её и снова нажмите «Перейти».`
      } else {
        field.scrollIntoView({ block: 'center' })
        findingNotice.value = `«${finding.title}»: поле временно недоступно, пока идёт запись. Повторите переход через несколько секунд.`
      }
    } else if (field) {
      field.scrollIntoView({ block: 'center' })
      field.focus({ preventScroll: true })
    } else {
      const section = document.getElementById(target.sectionId)
      if (section) {
        section.tabIndex = -1
        section.scrollIntoView({ block: 'start' })
        section.focus({ preventScroll: true })
      }
    }
  }
  async function openSetupImport(target: SetupImportTarget): Promise<void> {
    registryTab.value = 'imports'
    showView('registries')
    await nextTick()
    document.getElementById(target)?.scrollIntoView({ block: 'start' })
  }

  onMounted(() => void chooseStartTab())
  return {
    activeView,
    projectTab,
    registryTab,
    registriesVisited,
    helpSection,
    helpOpenKey,
    findingNotice,
    chooseProjectTab,
    openMyProjects,
    showView,
    openHelp,
    openSetupImport,
    navigateToFinding,
  }
}
