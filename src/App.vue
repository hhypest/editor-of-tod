<script setup lang="ts">
import { templateLabel } from './domain/registry'
import { computed, onMounted, ref } from 'vue'
import HelpPage from './components/HelpPage.vue'
import { invalidatePu66Status } from './composables/usePu66Status'
import SchemeDraftSheet from './components/SchemeDraftSheet.vue'
import { reviewScheme } from './domain/review-scheme'
import { usedSignCodes } from './domain/sign-images'
import { useProjectSession } from './composables/useProjectSession'
import { useNormativeRules } from './composables/useNormativeRules'

import ProjectHub from './components/editor/ProjectHub.vue'
import RegistryHub from './components/editor/RegistryHub.vue'
import EditorWorkspace from './components/editor/EditorWorkspace.vue'
import { useEditorNavigation } from './composables/useEditorNavigation'
const { reload: reloadNormativeRules, rules: normativeRules } = useNormativeRules()
const setupStatus = ref<{ cards: number; signs: number } | null>(null)
const setupError = ref('')
const session = useProjectSession(() => showView('source'))
const {
  imported,
  modifiedSinceLocalSave,
  localRevision,
  localBusy,
  localError,
  localNotice,
  editorDirty,
  recoveryStatus,
  placementDirty,
  saveLocally,
} = session
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
} = useEditorNavigation({ imported, placementDirty })

const signCatalogVersion = ref(0)
const pu66CatalogVersion = ref(0)
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
      ? 'Копия восстановления записана · сохраните редакцию'
      : 'Есть несохранённые правки'
  return localRevision.value === null ? 'Не сохранён' : 'Сохранён'
})

async function refreshSetupStatus(): Promise<void> {
  try {
    const [cardsResponse, signsResponse] = await Promise.all([
      fetch('/api/pu66'),
      fetch('/api/signs'),
    ])
    if (!cardsResponse.ok || !signsResponse.ok) throw new Error('Локальный API недоступен.')
    const [cards, signs]: [unknown, unknown] = await Promise.all([
      cardsResponse.json(),
      signsResponse.json(),
    ])
    if (!Array.isArray(cards) || !Array.isArray(signs)) throw new Error('Реестры недоступны.')
    setupStatus.value = { cards: cards.length, signs: signs.length }
    setupError.value = ''
  } catch {
    setupStatus.value = null
    setupError.value = 'Не удалось открыть локальные реестры. Проверьте, что npm run dev запущен.'
  }
}

function onSignsUpdated(): void {
  signCatalogVersion.value++
  // Смена документов меняет действующие редакции нормативных параметров.
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
const referencedSignIds = computed(() =>
  imported.value ? usedSignCodes(imported.value.scheme) : [],
)
</script>

<template>
  <main class="app-shell">
    <header class="topbar">
      <div class="brand-line">
        <strong class="brand">СОДД <span>/ редактор</span></strong>
        <span v-if="imported" class="project-name">{{ imported.scheme.crossing.referenceId }}</span>
        <span v-else class="project-name">Локальное рабочее место</span>
      </div>
      <div class="top-actions">
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

    <div class="app-layout">
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
          :session="session"
          :project-tab="projectTab"
          :active="activeView === 'projects'"
          :setup-status="setupStatus"
          :setup-error="setupError"
          @choose-tab="chooseProjectTab"
          @setup-import="openSetupImport"
          @help="openHelp"
        />
        <RegistryHub
          v-if="registriesVisited"
          v-show="activeView === 'registries'"
          :scheme="imported?.scheme ?? null"
          :view="activeView"
          :registry-tab="registryTab"
          :editor-dirty="editorDirty"
          :local-busy="localBusy"
          :referenced-sign-ids="referencedSignIds"
          :sign-catalog-version="signCatalogVersion"
          :pu66-catalog-version="pu66CatalogVersion"
          @choose-tab="registryTab = $event"
          @signs-updated="onSignsUpdated"
          @pu66-updated="onPu66Updated"
        />
        <HelpPage v-if="activeView === 'help'" :section="helpSection" :open-key="helpOpenKey" />
        <EditorWorkspace
          v-if="imported"
          :session="session"
          :active-view="activeView"
          :sign-catalog-version="signCatalogVersion"
          :pu66-catalog-version="pu66CatalogVersion"
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
            В проекте есть ограниченные сведения ПУ-66. Не публикуйте JSON и лист без разрешённой
            передачи.
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
