<script setup lang="ts">
import { templateLabel } from './domain/registry'
import { computed, onMounted, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useEditorNavigationStore } from './stores/editor-navigation'
import { useCatalogRefreshStore } from './stores/catalog-refresh'
import { useProjectDocumentStore } from './stores/project-document'
import { useProjectSessionUiStore } from './stores/project-session-ui'
import HelpPage from './components/HelpPage.vue'
import { usePu66StatusInvalidation } from './composables/usePu66Status'
import SchemeDraftSheet from './components/SchemeDraftSheet.vue'
import { reviewScheme } from './domain/review-scheme'
import { useProjectSession } from './composables/useProjectSession'
import type {
  ProjectHubCommands,
  EditorWorkspaceCommands,
} from './composables/project-view-commands'
import { useNormativeRules } from './composables/useNormativeRules'
import { parameterDefinitions } from './domain/normative-parameters'
import { loadSetupStatus } from './services/setup-status'
import type { FirstRunStatus } from './presentation/first-run'

import SetupWorkspace from './components/SetupWorkspace.vue'
import { ready } from './presentation/first-run'
import ProjectHub from './components/editor/ProjectHub.vue'
import RegistryHub from './components/editor/RegistryHub.vue'
import EditorWorkspace from './components/editor/EditorWorkspace.vue'
import { useEditorNavigation } from './composables/useEditorNavigation'
const invalidatePu66Status = usePu66StatusInvalidation()
const navigationState = storeToRefs(useEditorNavigationStore())
const { signCatalogVersion, pu66CatalogVersion } = storeToRefs(useCatalogRefreshStore())
const {
  reload: reloadNormativeRules,
  rules: normativeRules,
  states: normativeStates,
  error: normativeLoadError,
  loading: normativeLoading,
} = useNormativeRules()
const setupRegistryStatus = ref<{ cards: number; signs: number; projects: number } | null>(null)
const setupOpen = ref(false)
let startupChecked = false
function deferredSetup(): boolean {
  try {
    return sessionStorage.getItem('tod.setup.deferred') === '1'
  } catch {
    return false
  }
}
function closeSetup(): void {
  setupOpen.value = false
  try {
    sessionStorage.setItem('tod.setup.deferred', '1')
  } catch {
    /* Настройка доступна через кнопку. */
  }
}
function openSetup(): void {
  if (editorDirty.value || localBusy.value) return
  setupOpen.value = true
}
const setupStatus = computed<FirstRunStatus | null>(() => {
  if (!setupRegistryStatus.value) return null
  const confirmed = new Set(
    normativeStates.value
      .filter((state) => state.status.kind === 'confirmed')
      .map((state) => state.id),
  )
  const readiness = (definitions: typeof parameterDefinitions) => ({
    confirmed: definitions.filter((definition) => confirmed.has(definition.id)).length,
    total: definitions.length,
  })
  return {
    ...setupRegistryStatus.value,
    parameters: readiness(parameterDefinitions),
    parametersError: normativeLoadError.value,
    pdd: readiness(
      parameterDefinitions.filter(
        (definition) =>
          'documentCode' in definition.source && definition.source.documentCode === 'ПДД',
      ),
    ),
  }
})
watch([setupStatus, normativeLoading], ([status, loading]) => {
  if (!status || loading || startupChecked) return
  startupChecked = true
  const complete =
    status.signs > 0 &&
    status.cards > 0 &&
    !status.parametersError &&
    ready(status.parameters) &&
    ready(status.pdd)
  if (!complete && !imported.value && !setupRegistryStatus.value?.projects && !deferredSetup())
    setupOpen.value = true
})
const setupError = ref('')
const session = useProjectSession(() => showView('source'))
const { imported, modifiedSinceLocalSave, localRevision, editorDirty, placementDirty } =
  storeToRefs(useProjectDocumentStore())
const { localBusy, localError, localNotice, recoveryStatus } = storeToRefs(
  useProjectSessionUiStore(),
)
const { saveLocally } = session
const projectHubCommands: ProjectHubCommands = {
  openRecovery: session.openRecovery,
  discardRecovery: session.discardRecovery,
  createProject: session.createProject,
  openLocal: session.openLocal,
  restoreLocal: session.restoreLocal,
  onFileSelected: session.onFileSelected,
}
const editorWorkspaceCommands: EditorWorkspaceCommands = {
  saveAsNew: session.saveAsNew,
  exportCurrentProject: session.exportCurrentProject,
  exportOriginalProject: session.exportOriginalProject,
  stepBack: session.stepBack,
  stepForward: session.stepForward,
  onPu66Linked: session.onPu66Linked,
  buildDraftTemplate: session.buildDraftTemplate,
  pinCurrentSigns: session.pinCurrentSigns,
  onProjectApplied: session.onProjectApplied,
  onDetailsApplied: session.onDetailsApplied,
}
const {
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
} = useEditorNavigation({ imported, placementDirty }, navigationState)

// При возвращении обновляем состояние, в том числе после изменений в другом окне.
watch(activeView, (view) => {
  if (view === 'projects') {
    void refreshSetupStatus()
    void reloadNormativeRules()
  }
})

function onPu66Updated(): void {
  pu66CatalogVersion.value++
  invalidatePu66Status()
  void refreshSetupStatus()
}
onMounted(() => {
  void refreshSetupStatus()
  void reloadNormativeRules()
})
const saveState = computed(() => {
  if (recoveryStatus.value === 'error') return 'Копия восстановления не записана'
  if (recoveryStatus.value === 'pending' || recoveryStatus.value === 'saving')
    return 'Записываем копию восстановления…'
  if (editorDirty.value)
    return recoveryStatus.value === 'saved'
      ? 'Неприменённый ввод · копия восстановления записана'
      : 'Есть неприменённый ввод'
  if (modifiedSinceLocalSave.value)
    return recoveryStatus.value === 'saved'
      ? 'Копия восстановления записана · сохраните версию'
      : 'Есть несохранённые правки'
  return localRevision.value === null ? 'Не сохранён' : 'Сохранён'
})

let setupRequest = 0
async function refreshSetupStatus(): Promise<void> {
  const request = ++setupRequest
  try {
    const status = await loadSetupStatus()
    if (request !== setupRequest) return
    setupRegistryStatus.value = status
    setupError.value = ''
  } catch {
    if (request !== setupRequest) return
    setupRegistryStatus.value = null
    setupError.value =
      'Не удалось открыть реестры на этом компьютере. Перезапустите программу и повторите действие.'
  }
}

function onSetupRefresh(): void {
  onSignsUpdated()
  onPu66Updated()
}

function onSignsUpdated(): void {
  signCatalogVersion.value++
  // Смена документов меняет действующие версии нормативных параметров.
  void reloadNormativeRules()
  void refreshSetupStatus()
}

const fillCount = computed(() =>
  imported.value
    ? reviewScheme(imported.value.scheme, normativeRules.value).filter(
        (finding) => finding.kind === 'fill',
      ).length
    : 0,
)
</script>

<template>
  <main class="app-shell" :class="{ 'setup-active': setupOpen }">
    <header class="topbar">
      <div class="brand-line">
        <strong class="brand">СОДД <span>/ редактор</span></strong>
        <span v-if="imported" class="project-name">{{ imported.scheme.crossing.referenceId }}</span>
        <span v-else class="project-name">{{
          setupOpen ? 'Настройка рабочего места' : 'Локальное рабочее место'
        }}</span>
      </div>
      <div v-if="!setupOpen" class="top-actions">
        <span v-if="imported" class="save-state" role="status">
          {{ saveState }}
        </span>
        <button
          type="button"
          class="header-button"
          :aria-current="activeView === 'projects' ? 'page' : undefined"
          @click="showView('projects')"
        >
          Проекты
        </button>
        <button
          type="button"
          class="header-button"
          :aria-current="activeView === 'registries' ? 'page' : undefined"
          @click="showView('registries')"
        >
          Реестры
        </button>
        <button
          type="button"
          class="header-button"
          :aria-current="activeView === 'help' ? 'page' : undefined"
          title="Справка по текущему экрану"
          @click="openHelp()"
        >
          Справка
        </button>
        <button
          v-if="imported"
          type="button"
          class="top-save"
          :disabled="editorDirty || localBusy"
          @click="saveLocally"
        >
          Сохранить проект
        </button>
      </div>
    </header>

    <SetupWorkspace
      v-if="setupOpen && setupStatus"
      :status="setupStatus"
      :refresh-key="signCatalogVersion + pu66CatalogVersion"
      @refresh="onSetupRefresh"
      @exit="closeSetup"
      @finish="closeSetup"
    />
    <div v-show="!setupOpen" class="app-layout">
      <aside class="sidebar" aria-label="Этапы работы">
        <p class="sidebar-caption">{{ imported ? 'Схема · 4 этапа' : 'Начало работы' }}</p>
        <nav class="steps" aria-label="Подготовка схемы">
          <button
            type="button"
            class="step"
            :class="{ selected: activeView === 'source' }"
            :disabled="!imported"
            :aria-current="activeView === 'source' ? 'step' : undefined"
            @click="showView('source')"
          >
            <span class="step-number">1</span
            ><span><strong>Исходные данные</strong><small>Переезд и ПУ-66</small></span>
          </button>
          <button
            type="button"
            class="step"
            :class="{ selected: activeView === 'geometry' }"
            :disabled="!imported"
            :aria-current="activeView === 'geometry' ? 'step' : undefined"
            @click="showView('geometry')"
          >
            <span class="step-number">2</span
            ><span><strong>Схема движения</strong><small>Размеры и вариант</small></span>
          </button>
          <button
            type="button"
            class="step"
            :class="{ selected: activeView === 'objects' }"
            :disabled="!imported"
            :aria-current="activeView === 'objects' ? 'step' : undefined"
            @click="showView('objects')"
          >
            <span class="step-number">3</span
            ><span><strong>Знаки и объекты</strong><small>Поле и свойства</small></span>
          </button>
          <button
            type="button"
            class="step"
            :class="{ selected: activeView === 'review' }"
            :disabled="!imported"
            :aria-current="activeView === 'review' ? 'step' : undefined"
            @click="showView('review')"
          >
            <span class="step-number">4</span
            ><span><strong>Проверка и лист</strong><small>A4 для сверки</small></span>
          </button>
        </nav>
        <div class="sidebar-bottom">
          <p class="sidebar-caption">Рабочее место</p>
          <button
            type="button"
            :class="{ selected: activeView === 'projects' && projectTab === 'local' }"
            @click="openMyProjects"
          >
            Мои проекты
          </button>
          <button
            type="button"
            :class="{ selected: activeView === 'registries' }"
            @click="showView('registries')"
          >
            Локальные реестры
          </button>
          <button type="button" :class="{ selected: activeView === 'help' }" @click="openHelp()">
            Справка
          </button>
        </div>
      </aside>

      <div class="content">
        <p v-if="localError" class="feedback error" role="alert">{{ localError }}</p>
        <p v-if="localNotice" class="feedback notice" role="status">{{ localNotice }}</p>
        <p v-if="findingNotice" class="feedback notice" role="status">
          {{ findingNotice }}
          <button type="button" @click="findingNotice = ''">Скрыть</button>
        </p>

        <ProjectHub
          v-show="activeView === 'projects'"
          :commands="projectHubCommands"
          :setup-status="setupStatus"
          :setup-error="setupError"
          @open-setup="openSetup"
          @choose-tab="chooseProjectTab"
          @setup-import="openSetupImport"
          @help="openHelp"
        />
        <RegistryHub
          v-if="registriesVisited"
          v-show="activeView === 'registries'"
          @choose-tab="registryTab = $event"
          @signs-updated="onSignsUpdated"
          @pu66-updated="onPu66Updated"
        />
        <HelpPage v-if="activeView === 'help'" :section="helpSection" :open-key="helpOpenKey" />
        <EditorWorkspace
          v-if="imported"
          :commands="editorWorkspaceCommands"
          @show="showView"
          @navigate="navigateToFinding"
        />
      </div>

      <aside class="preview" aria-label="Предпросмотр схемы">
        <template v-if="imported">
          <div class="preview-heading">
            <strong>Лист схемы</strong
            ><span class="variant-badge">{{ templateLabel(imported.scheme.template.code) }}</span>
          </div>
          <SchemeDraftSheet
            :key="`mini-${signCatalogVersion}`"
            class="mini-sheet"
            :scheme="imported.scheme"
            :has-pending-input="editorDirty"
            :local-revision="localRevision"
            :modified-since-local-save="modifiedSinceLocalSave"
            preview-only
          />
          <p class="preview-note">
            Условный черновик обновляется после применения правок. Масштаб здесь уменьшен.
          </p>
          <button type="button" class="preview-open" @click="showView('review')">
            Открыть лист A4 и печать →
          </button>
          <div class="preview-check">
            <strong>Проверка заполнения</strong
            ><span>{{
              fillCount ? `Нужно уточнить: ${fillCount}` : 'Поля из списка заполнены'
            }}</span
            ><small>Нормативная проверка выполняется отдельно.</small>
          </div>
          <p v-if="imported.scheme.crossing.source === 'local-pu66'" class="private-note">
            В проекте есть ограниченные сведения ПУ-66. Не публикуйте файл проекта и лист без
            разрешённой передачи.
          </p>
        </template>
        <div v-else class="preview-empty">
          <span class="preview-mark">СОДД</span><strong>Начните с проекта</strong>
          <p>
            После открытия здесь появится уменьшенный лист схемы. Печатный A4 находится на четвёртом
            этапе.
          </p>
        </div>
      </aside>
    </div>
  </main>
</template>

<style scoped src="./styles/editor-common.css" />
<style scoped src="./styles/App.css" />
<style scoped>
.app-shell.setup-active {
  background: #f1f5ee;
}
.setup-active .topbar {
  min-height: 3rem;
  padding: 0.5rem 1.5rem;
}
</style>
