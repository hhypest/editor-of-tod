<script setup lang="ts">
import DiagnosticsPanel from './components/DiagnosticsPanel.vue'
import { templateLabel } from './domain/registry'
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import LocalRegistries from './components/LocalRegistries.vue'
import ImportedData from './components/ImportedData.vue'
import LocalProjects from './components/LocalProjects.vue'
import NewScheme from './components/NewScheme.vue'
import NormativeDocuments from './components/NormativeDocuments.vue'
import NormativeParameters from './components/NormativeParameters.vue'
import HelpPage from './components/HelpPage.vue'
import { helpSectionFor } from './help/help-content'
import PlacementEditor from './components/PlacementEditor.vue'
import Pu66Linker from './components/Pu66Linker.vue'
import Pu66Lifecycle from './components/Pu66Lifecycle.vue'
import { invalidatePu66Status } from './composables/usePu66Status'
import SchemeDraftSheet from './components/SchemeDraftSheet.vue'
import SchemeReview from './components/SchemeReview.vue'
import SchemeWorkspace from './components/SchemeWorkspace.vue'
import SchemeDetailsEditor from './components/SchemeDetailsEditor.vue'
import TemplateChoice from './components/TemplateChoice.vue'
import ProjectDataInspector from './components/ProjectDataInspector.vue'
import { reviewScheme, type ReviewFinding } from './domain/review-scheme'
import { usedSignCodes } from './domain/sign-images'
import { useProjectSession } from './composables/useProjectSession'
import { listLocalProjects } from './services/local-projects'
import { useNormativeRules } from './composables/useNormativeRules'

type View = 'projects' | 'source' | 'geometry' | 'objects' | 'review' | 'registries' | 'help'
const stages = ['source', 'geometry', 'objects', 'review'] as const
const activeView = ref<View>('projects')
const projectTab = ref<'new' | 'file' | 'local'>('new')
/** Вкладку выбрал сам составитель — после этого стартовая вкладка не переключается. */
const projectTabChosen = ref(false)
function chooseProjectTab(tab: 'new' | 'file' | 'local'): void {
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
const { reload: reloadNormativeRules, rules: normativeRules } = useNormativeRules()
const registryTab = ref<'imports' | 'documents' | 'parameters' | 'entries' | 'diagnostics'>(
  'imports',
)
const registriesVisited = ref(false)
const setupStatus = ref<{ cards: number; signs: number } | null>(null)
const setupError = ref('')
const {
  imported,
  selectedFileName,
  errorMessage,
  loading,
  detailsDirty,
  placementDirty,
  modifiedSinceLocalSave,
  localRevision,
  localBusy,
  localError,
  localNotice,
  projectsRefreshKey,
  history,
  selectedPlacementId,
  templateMessage,
  templateError,
  signPinMessage,
  editorDirty,
  recoveryCopies,
  activeRecoveryId,
  recoveryStatus,
  recoverySeed,
  pendingDetails,
  pendingPlacement,
  openRecovery,
  discardRecovery,
  onFileSelected,
  saveV5,
  saveOriginal,
  createProject,
  saveLocally,
  saveAsNew,
  openLocal,
  restoreLocal,
  onProjectApplied,
  buildDraftTemplate,
  pinCurrentSigns,
  onPu66Linked,
  stepBack,
  stepForward,
} = useProjectSession(() => showView('source'))

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
  void chooseStartTab()
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

async function openSetupImport(target: 'pdf-sign-import' | 'pu66-import'): Promise<void> {
  registryTab.value = 'imports'
  showView('registries')
  await nextTick()
  document.getElementById(target)?.scrollIntoView({ block: 'start' })
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
const detailsMode = computed<'source' | 'geometry' | 'title'>(() =>
  activeView.value === 'source' ? 'source' : activeView.value === 'geometry' ? 'geometry' : 'title',
)
const frontMetres = computed(
  () =>
    imported.value?.scheme.parameters.workZones[imported.value.scheme.template.code]?.workMetres,
)
const referencedSignIds = computed(() =>
  imported.value ? usedSignCodes(imported.value.scheme) : [],
)

/** Экран открытого проекта (этапы 1–4), а не общий раздел. */
const inProject = computed(
  () =>
    activeView.value !== 'projects' &&
    activeView.value !== 'registries' &&
    activeView.value !== 'help',
)
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

function showView(view: View): void {
  if (!imported.value && stages.includes(view as (typeof stages)[number])) return
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
  let view: View = 'review'
  if (finding.target === '#pu66-link-title' || finding.id === 'place') view = 'source'
  else if (finding.target === '#placements-title') view = 'objects'
  else if (finding.target === '#imported-title') {
    view = 'registries'
    registryTab.value = 'imports'
  } else if (
    // Поля параметров схемы (кроме места работ) стоят на этапе 2 «Схема движения».
    finding.field?.startsWith('parameters.') ||
    finding.id.startsWith('distance-') ||
    ['figure-dimensions', 'variant-front', 'boundary-30', 'legacy-visibility'].includes(finding.id)
  )
    view = 'geometry'
  showView(view)
  await nextTick()
  const field = finding.field
    ? [...document.querySelectorAll<HTMLElement>(`[data-field="${finding.field}"]`)].find(
        (element) => element.offsetParent !== null,
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
    document.getElementById(finding.target.slice(1))?.scrollIntoView({ block: 'start' })
  }
}
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

        <section v-show="activeView === 'projects'" class="view" aria-labelledby="projects-heading">
          <div class="view-heading">
            <p class="eyebrow">Рабочее место</p>
            <h1 id="projects-heading">Проекты схем</h1>
            <p>
              Продолжите сохранённый проект, начните новую схему по карточке ПУ-66 или откройте файл
              проекта (JSON), полученный от коллеги или из прежней версии программы.
            </p>
          </div>
          <section v-if="recoveryCopies.length" class="module" aria-labelledby="recovery-heading">
            <h2 id="recovery-heading">Копии восстановления</h2>
            <p class="hint">
              Здесь остаются правки, которые не успели сохранить до закрытия окна. Копия хранится на
              этом компьютере отдельно от сохранённых версий проекта.
            </p>
            <ul>
              <li v-for="copy in recoveryCopies" :key="copy.sessionId">
                <strong>{{ copy.referenceId }}</strong> · {{ copy.fileName }} ·
                {{ new Date(copy.updatedAt).toLocaleString('ru-RU') }}
                <span v-if="copy.sessionId === activeRecoveryId"> · открыта сейчас</span>
                <span v-else-if="copy.active"> · открыта в другом окне</span>
                <button
                  type="button"
                  :disabled="localBusy || loading || copy.active"
                  @click="openRecovery(copy.sessionId)"
                >
                  Восстановить
                </button>
                <button
                  type="button"
                  :disabled="localBusy || copy.active || copy.sessionId === activeRecoveryId"
                  @click="discardRecovery(copy.sessionId, copy.version)"
                >
                  Удалить копию
                </button>
              </li>
            </ul>
          </section>
          <section
            v-if="setupStatus && (!setupStatus.signs || !setupStatus.cards)"
            class="setup-guide module"
            aria-labelledby="setup-heading"
          >
            <p class="eyebrow">Первый запуск · локальная SQLite готова</p>
            <h2 id="setup-heading">Наполните реестры на этом компьютере</h2>
            <p>
              Локальная база находится в private-data/registry.sqlite. Добавьте недостающие реестры:
              знаки из PDF ГОСТ Р 52290 и книги ПУ-66. Файлы выбираются с этого компьютера; после
              просмотра изменений подтвердите запись.
            </p>
            <p>
              <button type="button" class="link-button" @click="openHelp('first-run')">
                Порядок настройки в справке
              </button>
            </p>
            <ol class="setup-steps">
              <li>
                <strong
                  >Знаки:
                  {{ setupStatus.signs ? `${setupStatus.signs} в базе` : 'пока нет' }}</strong
                >
                <p>
                  Прикрепите PDF ГОСТ Р 52290 в «Нормативных документах» и извлеките из него знаки
                  (или загрузите ZIP с PNG).
                </p>
                <button type="button" @click="openSetupImport('pdf-sign-import')">
                  {{ setupStatus.signs ? 'Открыть каталог' : 'Извлечь знаки из PDF' }}
                </button>
              </li>
              <li>
                <strong
                  >ПУ-66:
                  {{ setupStatus.cards ? `${setupStatus.cards} в базе` : 'пока нет' }}</strong
                >
                <p>
                  Без карточек ПУ-66 новый проект не создаётся. Выберите сразу все XLSX (до 100
                  книг); для пробы можно создать вымышленные книги командой npm run samples:pu66.
                </p>
                <button type="button" @click="openSetupImport('pu66-import')">
                  {{ setupStatus.cards ? 'Открыть карточки' : 'Импортировать ПУ-66' }}
                </button>
              </li>
            </ol>
            <p class="hint">
              Импорт не отмечает ежегодную сверку ПУ-66; её регистрирует линейное подразделение
              после фактической проверки.
            </p>
          </section>
          <p v-if="setupError" class="feedback error" role="alert">{{ setupError }}</p>
          <div class="tabs" role="group" aria-label="Способ открытия проекта">
            <button
              type="button"
              :aria-pressed="projectTab === 'local'"
              @click="chooseProjectTab('local')"
            >
              Мои проекты
            </button>
            <button
              type="button"
              :aria-pressed="projectTab === 'new'"
              @click="chooseProjectTab('new')"
            >
              Новый проект
            </button>
            <button
              type="button"
              :aria-pressed="projectTab === 'file'"
              @click="chooseProjectTab('file')"
            >
              Открыть файл
            </button>
          </div>
          <NewScheme
            v-show="projectTab === 'new'"
            class="module"
            :locked="localBusy || loading"
            :active="projectTab === 'new' && activeView === 'projects'"
            @create="createProject"
            @import-pu66="openSetupImport('pu66-import')"
          />
          <LocalProjects
            v-if="projectTab === 'local'"
            class="module"
            :active-id="imported?.scheme.id ?? null"
            :active-revision="localRevision"
            :refresh-key="projectsRefreshKey"
            :locked="localBusy || loading"
            @open="openLocal"
            @restore="restoreLocal"
            @create="chooseProjectTab('new')"
          />
          <section v-show="projectTab === 'file'" class="module" aria-labelledby="import-title">
            <h2 id="import-title">Открыть файл проекта</h2>
            <label for="scheme-file" class="file-label">Файл .json с вашего компьютера</label>
            <input
              id="scheme-file"
              type="file"
              accept=".json,application/json"
              :disabled="localBusy"
              @change="onFileSelected"
            />
            <p class="hint">
              Файл проекта скачивается кнопкой «Скачать файл проекта (JSON)». Подходят файлы всех
              прежних версий программы (v1 и schemaVersion 2–7) размером до 32 МБ. Открытый файл не
              попадает в «Мои проекты», пока вы не нажмёте «Сохранить проект».
            </p>
            <p v-if="loading" class="hint" role="status">Проверяем файл…</p>
            <p v-if="errorMessage" class="error" role="alert">{{ errorMessage }}</p>
          </section>
        </section>

        <section
          v-if="registriesVisited"
          v-show="activeView === 'registries'"
          class="view"
          aria-labelledby="registries-heading"
        >
          <div class="view-heading">
            <p class="eyebrow">Отдельный раздел</p>
            <h1 id="registries-heading">Локальные реестры</h1>
            <p>
              Карточки ПУ-66, каталог знаков и нормативные документы остаются в базе на этом
              компьютере.
            </p>
          </div>
          <div class="tabs" role="group" aria-label="Раздел реестров">
            <button
              type="button"
              :aria-pressed="registryTab === 'imports'"
              @click="registryTab = 'imports'"
            >
              Импорт Excel и знаков
            </button>
            <button
              type="button"
              :aria-pressed="registryTab === 'documents'"
              @click="registryTab = 'documents'"
            >
              Нормативные документы
            </button>
            <button
              type="button"
              :aria-pressed="registryTab === 'parameters'"
              @click="registryTab = 'parameters'"
            >
              Нормативные параметры
            </button>
            <button
              type="button"
              :aria-pressed="registryTab === 'entries'"
              @click="registryTab = 'entries'"
            >
              Карточки и нормативы
            </button>
            <button
              type="button"
              :aria-pressed="registryTab === 'diagnostics'"
              @click="registryTab = 'diagnostics'"
            >
              Диагностика
            </button>
          </div>
          <ImportedData
            v-show="registryTab === 'imports'"
            class="module"
            :referenced-sign-ids="referencedSignIds"
            :locked="editorDirty"
            :refresh-key="signCatalogVersion + pu66CatalogVersion"
            @signs-updated="onSignsUpdated"
            @pu66-updated="onPu66Updated"
          />
          <NormativeDocuments
            v-if="registryTab === 'documents'"
            class="module"
            :locked="editorDirty"
            @changed="onSignsUpdated"
          />
          <NormativeParameters
            v-if="registryTab === 'parameters'"
            class="module"
            :refresh-key="signCatalogVersion"
          />
          <Pu66Lifecycle
            v-show="registryTab === 'entries'"
            class="module"
            :locked="localBusy"
            :refresh-key="pu66CatalogVersion"
            @changed="onPu66Updated"
          />
          <LocalRegistries v-show="registryTab === 'entries'" class="module" />
          <DiagnosticsPanel
            v-if="registryTab === 'diagnostics'"
            class="module"
            :scheme="imported?.scheme ?? null"
            :view="activeView"
          />
        </section>

        <HelpPage v-if="activeView === 'help'" :section="helpSection" :open-key="helpOpenKey" />

        <template v-if="imported">
          <div v-show="inProject" class="project-bar">
            <div>
              <span class="eyebrow">{{ selectedFileName }}</span
              ><strong
                >Переезд {{ imported.scheme.crossing.referenceId }} ·
                {{ templateLabel(imported.scheme.template.code) }}</strong
              ><span class="project-meta"
                >Фронт {{ frontMetres ?? 'не указан' }} м · объектов
                {{ imported.scheme.placements.length }} · редакция
                {{ localRevision ?? 'не сохранена' }}</span
              >
            </div>
            <details class="more-actions">
              <summary>Действия с проектом</summary>
              <div class="more-buttons">
                <button type="button" :disabled="editorDirty || localBusy" @click="saveAsNew">
                  Сохранить как новый проект
                </button>
                <button type="button" :disabled="editorDirty || localBusy" @click="saveV5">
                  Скачать файл проекта (JSON)
                </button>
                <button
                  v-if="imported.scheme.source.kind === 'legacy-html-v1'"
                  type="button"
                  @click="saveOriginal"
                >
                  Скачать исходный JSON
                </button>
                <button
                  type="button"
                  :disabled="editorDirty || localBusy || !history?.past.length"
                  @click="stepBack"
                >
                  Отменить действие
                </button>
                <button
                  type="button"
                  :disabled="editorDirty || localBusy || !history?.future.length"
                  @click="stepForward"
                >
                  Повторить действие
                </button>
              </div>
            </details>
          </div>
          <p v-show="inProject && editorDirty" class="feedback pending" role="status">
            Есть неприменённый ввод. Вернитесь к изменённой форме и нажмите «Применить правки» или
            «Отменить ввод» перед сохранением и печатью.
          </p>

          <section
            v-show="activeView === 'source'"
            class="view stage"
            aria-label="Этап 1. Исходные данные"
          >
            <div class="view-heading">
              <p class="eyebrow">Этап 1 из 4</p>
              <h1>Исходные данные</h1>
              <p>
                Уточните место работ, направления и закрепите разрешённые сведения из локальной
                карточки ПУ-66.
              </p>
            </div>
            <details v-if="imported.warnings.length" class="opening-notes">
              <summary>Сообщения при открытии · {{ imported.warnings.length }}</summary>
              <ul>
                <li v-for="warning in imported.warnings" :key="warning">{{ warning }}</li>
              </ul>
            </details>
            <Pu66Linker
              class="module"
              :scheme="imported.scheme"
              :locked="editorDirty || localBusy"
              :refresh-key="pu66CatalogVersion"
              @apply="onPu66Linked"
            />
          </section>

          <section
            v-show="activeView === 'geometry'"
            class="view stage"
            aria-label="Этап 2. Схема движения"
          >
            <div class="view-heading">
              <p class="eyebrow">Этап 2 из 4</p>
              <h1>Схема движения</h1>
              <p>
                Размеры и параметры выбранного рисунка ОДМ. Изменение чисел не перемещает уже
                поставленные знаки.
              </p>
            </div>
            <div class="variant-summary">
              <span>Вариант по проекту</span
              ><strong>{{ templateLabel(imported.scheme.template.code) }}</strong
              ><span>Фронт {{ frontMetres ?? 'не указан' }} м</span>
            </div>
            <details class="reference">
              <summary>Как выбран Б.33 или Б.34</summary>
              <TemplateChoice />
            </details>
          </section>

          <section
            v-show="activeView === 'objects'"
            class="view stage"
            aria-label="Этап 3. Знаки и объекты"
          >
            <div class="view-heading">
              <p class="eyebrow">Этап 3 из 4</p>
              <h1>Знаки и объекты</h1>
              <p>
                Работайте с условным полем схемы. Свойства выделенного объекта и палитра находятся
                ниже поля.
              </p>
            </div>
            <section class="module" aria-label="Черновая расстановка">
              <h2>Черновая расстановка по Б.33/Б.34</h2>
              <p>
                Укажите местоположение и решение о регулировании на этапе 2. Расстановка по ОДМ
                218.6.019-2016 (рис. Б.33/Б.34) использует условные координаты; проверьте условия
                дороги и применимость каждого знака. Повторная сборка заменит только объекты
                шаблона, ручные правки останутся.
              </p>
              <button
                type="button"
                :disabled="editorDirty || localBusy"
                @click="buildDraftTemplate"
              >
                Собрать черновой шаблон
              </button>
              <button type="button" :disabled="editorDirty || localBusy" @click="pinCurrentSigns">
                Закрепить редакции PNG
              </button>
              <p v-if="signPinMessage" role="status">{{ signPinMessage }}</p>
              <p v-if="templateMessage" role="status">{{ templateMessage }}</p>
              <p v-if="templateError" class="error" role="alert">{{ templateError }}</p>
            </section>
            <SchemeWorkspace
              :key="`workspace-${signCatalogVersion}`"
              class="module"
              :scheme="imported.scheme"
              :selected-id="selectedPlacementId"
              :locked="editorDirty || localBusy"
              @apply="onProjectApplied"
              @select="selectedPlacementId = $event"
            />
            <PlacementEditor
              :key="`placements-${signCatalogVersion}`"
              class="module"
              :scheme="imported.scheme"
              :locked="detailsDirty || localBusy"
              :selected-placement-id="selectedPlacementId"
              :recovery="recoverySeed"
              @apply="onProjectApplied"
              @dirty="placementDirty = $event"
              @draft="pendingPlacement = $event"
              @select="selectedPlacementId = $event"
            />
          </section>

          <section
            v-show="activeView === 'review'"
            class="view stage"
            aria-label="Этап 4. Проверка и лист"
          >
            <div class="view-heading">
              <p class="eyebrow">Этап 4 из 4</p>
              <h1>Проверка и лист A4</h1>
              <p>
                Заполните реквизиты, просмотрите замечания и распечатайте условный черновик для
                внутренней сверки.
              </p>
            </div>
            <SchemeReview
              class="module"
              :scheme="imported.scheme"
              :has-pending-input="editorDirty"
              :locked="localBusy"
              @navigate="navigateToFinding"
              @apply="onProjectApplied"
            />
          </section>

          <SchemeDetailsEditor
            v-show="activeView === 'source' || activeView === 'geometry' || activeView === 'review'"
            class="module details-module"
            :scheme="imported.scheme"
            :mode="detailsMode"
            :recovery="recoverySeed"
            :locked="placementDirty || localBusy"
            @apply="onProjectApplied"
            @dirty="detailsDirty = $event"
            @draft="pendingDetails = $event"
          />
          <SchemeDraftSheet
            v-show="activeView === 'review'"
            :key="`sheet-${signCatalogVersion}`"
            class="module print-host"
            :scheme="imported.scheme"
            :has-pending-input="editorDirty"
            :local-revision="localRevision"
            :modified-since-local-save="modifiedSinceLocalSave"
          />
          <ProjectDataInspector
            v-show="activeView === 'review'"
            class="data-inspector"
            :scheme="imported.scheme"
          />

          <nav v-show="inProject" class="stage-controls" aria-label="Переход между этапами">
            <button v-if="activeView === 'source'" type="button" @click="showView('projects')">
              ← К проектам
            </button>
            <button v-if="activeView === 'geometry'" type="button" @click="showView('source')">
              ← Исходные данные
            </button>
            <button v-if="activeView === 'objects'" type="button" @click="showView('geometry')">
              ← Схема движения
            </button>
            <button v-if="activeView === 'review'" type="button" @click="showView('objects')">
              ← Знаки и объекты
            </button>
            <button
              v-if="activeView === 'source'"
              type="button"
              class="primary"
              @click="showView('geometry')"
            >
              К схеме движения →
            </button>
            <button
              v-if="activeView === 'geometry'"
              type="button"
              class="primary"
              @click="showView('objects')"
            >
              К знакам и объектам →
            </button>
            <button
              v-if="activeView === 'objects'"
              type="button"
              class="primary"
              @click="showView('review')"
            >
              К проверке и листу →
            </button>
          </nav>
        </template>
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

<style scoped>
.app-shell {
  min-height: 100vh;
  background: #f3f6f4;
  color: #20323a;
  font-family:
    system-ui,
    -apple-system,
    'Segoe UI',
    sans-serif;
}
.topbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 1rem;
  min-height: 4.2rem;
  padding: 0.7rem clamp(1rem, 2vw, 2rem);
  background: #fff;
  border-bottom: 1px solid #dce5e1;
}
.brand-line,
.top-actions {
  display: flex;
  align-items: center;
  gap: 0.85rem;
  flex-wrap: wrap;
}
.brand {
  font-size: 1.1rem;
  letter-spacing: -0.03em;
  white-space: nowrap;
  color: #205e50;
}
.brand span {
  color: #597168;
  font-weight: 500;
}
.project-name {
  color: #587069;
  font-size: 0.85rem;
  overflow-wrap: anywhere;
}
.top-actions {
  justify-content: flex-end;
}
.save-state {
  font-size: 0.78rem;
  color: #50685f;
}
.save-state::before {
  content: '';
  display: inline-block;
  width: 0.42rem;
  height: 0.42rem;
  margin-right: 0.4rem;
  background: #5f9f78;
  border-radius: 50%;
  vertical-align: middle;
}
button {
  padding: 0.65rem 0.9rem;
  border: 1px solid #a7c1b6;
  border-radius: 0.48rem;
  background: #fff;
  color: #205e50;
  font: inherit;
  font-weight: 650;
  cursor: pointer;
}
button:hover:not(:disabled) {
  background: #eaf3ee;
}
button:focus-visible {
  outline: 3px solid #32856b;
  outline-offset: 2px;
}
button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.header-button {
  border-color: transparent;
  font-size: 0.88rem;
}
.header-button[aria-current='page'] {
  background: #e7f1ea;
}
.top-save,
button.primary {
  background: #226c55;
  border-color: #226c55;
  color: #fff;
}
.top-save:hover:not(:disabled),
button.primary:hover:not(:disabled) {
  background: #185b47;
}
.app-layout {
  display: grid;
  grid-template-columns: 190px minmax(0, 1fr) 260px;
  max-width: 1720px;
  margin: auto;
  min-height: calc(100vh - 4.2rem);
}
.sidebar {
  border-right: 1px solid #dce5e1;
  background: #eaf1ec;
  padding: 1.35rem 0.75rem;
}
.sidebar-caption {
  margin: 0.1rem 0.75rem 0.9rem;
  color: #597168;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  font-size: 0.68rem;
  font-weight: 750;
}
.steps {
  display: grid;
  gap: 0.35rem;
}
.step {
  display: flex;
  width: 100%;
  gap: 0.65rem;
  align-items: flex-start;
  padding: 0.7rem 0.55rem;
  border: 0;
  background: transparent;
  color: #293e3a;
  text-align: left;
}
.step.selected,
.sidebar-bottom button.selected {
  background: #fff;
  box-shadow: 0 2px 8px rgb(26 63 45 / 7%);
}
.step-number {
  flex: none;
  display: grid;
  place-items: center;
  width: 1.55rem;
  height: 1.55rem;
  border-radius: 50%;
  background: #d7e2db;
  color: #526c61;
  font-size: 0.75rem;
}
.step.selected .step-number {
  background: #226c55;
  color: white;
}
.step strong {
  display: block;
  font-size: 0.83rem;
  line-height: 1.35;
}
.step small {
  display: block;
  margin-top: 0.15rem;
  color: #687b70;
  font-size: 0.7rem;
  line-height: 1.3;
}
.sidebar-bottom {
  margin-top: 2rem;
  padding-top: 1rem;
  border-top: 1px solid #d2dfd5;
}
.sidebar-bottom button {
  display: block;
  width: 100%;
  padding: 0.65rem 0.75rem;
  border: 0;
  text-align: left;
  background: transparent;
  font-size: 0.82rem;
}
.content {
  min-width: 0;
  padding: 1.5rem clamp(0.9rem, 2vw, 2rem) 2.5rem;
}
.view-heading {
  margin: 0 0 1.3rem;
}
.eyebrow {
  display: block;
  margin: 0 0 0.28rem;
  color: #286b56;
  font-size: 0.74rem;
  font-weight: 750;
  overflow-wrap: anywhere;
}
h1 {
  margin: 0 0 0.45rem;
  font-size: clamp(1.6rem, 2.3vw, 2.15rem);
  letter-spacing: -0.035em;
  line-height: 1.18;
}
h2 {
  margin: 0 0 0.8rem;
  font-size: 1.35rem;
}
.view-heading p:last-child,
.hint {
  color: #586d65;
  line-height: 1.5;
  font-size: 0.91rem;
}
.view-heading p:last-child {
  max-width: 54rem;
  margin: 0.3rem 0 0;
}
.tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 0.45rem;
  padding: 0.25rem 0 1rem;
}
.tabs button {
  background: transparent;
  border: 1px solid #cfdbd4;
  font-size: 0.86rem;
}
.tabs button[aria-pressed='true'] {
  background: #e1f0e5;
  border-color: #7aae92;
  color: #154e3d;
}
.module {
  min-width: 0;
  margin: 0 0 1rem;
  padding: clamp(1rem, 2vw, 1.5rem);
  background: #fff;
  border: 1px solid #dce5e1;
  border-radius: 0.7rem;
  box-shadow: 0 2px 8px rgb(22 56 40 / 4%);
}
.module + .module {
  margin-top: 1rem;
}
.setup-guide {
  border-color: #a7c9b5;
  background: #f8fcf8;
}
.setup-guide h2 {
  margin-bottom: 0.5rem;
}
.setup-guide > p {
  line-height: 1.5;
}
.setup-steps {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(230px, 1fr));
  gap: 0.8rem;
  padding: 0;
  list-style: none;
}
.setup-steps li {
  padding: 1rem;
  border: 1px solid #d3e3d8;
  border-radius: 0.6rem;
  background: #fff;
}
.setup-steps strong {
  display: block;
}
.setup-steps p {
  color: #586d65;
  font-size: 0.88rem;
  line-height: 1.5;
}
.file-label {
  display: block;
  margin-bottom: 0.55rem;
  font-weight: 700;
}
input[type='file'] {
  max-width: 100%;
  font: inherit;
}
.error {
  color: #a01f31;
}
.feedback {
  margin: 0 0 1rem;
  padding: 0.85rem 1rem;
  border-radius: 0.55rem;
  font-size: 0.87rem;
  line-height: 1.45;
}
.feedback.error {
  background: #fff0f1;
  border-left: 3px solid #bb3b46;
}
.feedback.notice {
  background: #e8f5e9;
  border-left: 3px solid #5c9d69;
}
.feedback.pending {
  background: #fff6e6;
  border-left: 3px solid #b48737;
  color: #594119;
}
.project-bar {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 1rem;
  margin-bottom: 1.2rem;
  padding: 1rem 1.15rem;
  border: 1px solid #dce5e1;
  border-radius: 0.7rem;
  background: #fff;
}
.project-bar strong,
.project-meta {
  display: block;
}
.project-bar strong {
  font-size: 1rem;
  margin: 0.2rem 0;
}
.project-meta {
  color: #61736b;
  font-size: 0.78rem;
}
.more-actions {
  flex: none;
  position: relative;
}
.more-actions summary {
  list-style: none;
  padding: 0.55rem 0.75rem;
  border: 1px solid #a7c1b6;
  border-radius: 0.45rem;
  color: #205e50;
  font-weight: 650;
  font-size: 0.82rem;
  cursor: pointer;
}
.more-actions summary::-webkit-details-marker {
  display: none;
}
.more-actions[open] .more-buttons {
  display: grid;
  gap: 0.4rem;
  position: absolute;
  top: calc(100% + 0.35rem);
  right: 0;
  z-index: 5;
  width: min(18rem, 75vw);
  padding: 0.7rem;
  background: #fff;
  border: 1px solid #d0ddd5;
  border-radius: 0.6rem;
  box-shadow: 0 12px 26px rgb(26 55 39 / 16%);
}
.more-buttons button {
  text-align: left;
  font-size: 0.78rem;
}
.opening-notes,
.reference {
  padding: 0.8rem 1rem;
  margin-bottom: 1rem;
  border: 1px solid #dce5e1;
  border-radius: 0.6rem;
  background: #fff;
}
.opening-notes summary,
.reference summary {
  cursor: pointer;
  font-weight: 700;
  color: #245f50;
}
.opening-notes ul {
  margin: 0.8rem 0 0;
  padding-left: 1.3rem;
  color: #4d645b;
}
.variant-summary {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  flex-wrap: wrap;
  padding: 1rem 1.2rem;
  margin-bottom: 1rem;
  background: #e3f1e8;
  border-radius: 0.6rem;
  color: #2a5945;
}
.variant-summary strong {
  font-size: 1.4rem;
}
.details-module {
  margin-top: 1rem;
}
.data-inspector {
  display: block;
  margin-top: 1rem;
}
.stage-controls {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.8rem;
  flex-wrap: wrap;
  margin-top: 1.25rem;
  padding-top: 1rem;
  border-top: 1px solid #dce5e1;
}
.preview {
  min-width: 0;
  padding: 1.45rem 0.9rem;
  border-left: 1px solid #dce5e1;
  background: #e9f0eb;
}
.preview-heading {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 1rem;
  font-size: 0.92rem;
}
.variant-badge {
  padding: 0.25rem 0.5rem;
  border-radius: 10rem;
  background: #d7ebdf;
  color: #23654b;
  font-size: 0.75rem;
  font-weight: 750;
}
.mini-sheet {
  overflow: hidden;
  border: 1px solid #ccd8d1;
  box-shadow: 0 7px 20px rgb(23 56 41 / 13%);
}
.preview-note,
.private-note {
  color: #53685e;
  font-size: 0.78rem;
  line-height: 1.5;
}
.link-button {
  padding: 0;
  border: 0;
  background: none;
  color: #185ca5;
  font: inherit;
  text-decoration: underline;
  cursor: pointer;
}
.preview-open {
  width: 100%;
  margin: 0.5rem 0 1rem;
  text-align: center;
  font-size: 0.77rem;
}
.preview-check {
  display: grid;
  gap: 0.35rem;
  padding: 1rem 0;
  border-top: 1px solid #cddcd1;
  font-size: 0.82rem;
}
.preview-check span {
  color: #285d48;
}
.preview-check small {
  color: #617269;
  line-height: 1.35;
}
.private-note {
  padding: 0.7rem;
  border-left: 3px solid #b78743;
  background: #f9f2e3;
}
.preview-empty {
  display: grid;
  gap: 0.8rem;
  align-content: start;
  padding: 1.2rem 0.6rem;
  color: #50685b;
}
.preview-empty strong {
  color: #235848;
}
.preview-empty p {
  margin: 0;
  line-height: 1.5;
  font-size: 0.85rem;
}
.preview-mark {
  display: grid;
  place-items: center;
  width: 5rem;
  height: 5rem;
  border-radius: 1rem;
  background: #d6e9dc;
  color: #2a6551;
  font-weight: 800;
}
@media (max-width: 1100px) {
  .app-layout {
    grid-template-columns: 175px minmax(0, 1fr);
  }
  .preview {
    grid-column: 2;
    border-left: 0;
    border-top: 1px solid #dce5e1;
    display: grid;
    grid-template-columns: 230px minmax(0, 1fr);
    gap: 0.6rem 1rem;
    align-content: start;
  }
  .preview-heading {
    grid-column: 1/-1;
    margin: 0;
  }
  .mini-sheet {
    grid-row: 2 / span 3;
  }
  .preview-empty {
    grid-column: 1/-1;
  }
}
@media (max-width: 700px) {
  .topbar {
    align-items: flex-start;
    flex-wrap: wrap;
  }
  .top-actions {
    justify-content: flex-start;
  }
  .app-layout {
    display: block;
  }
  .sidebar {
    padding: 0.65rem;
    border-right: 0;
    border-bottom: 1px solid #dce5e1;
  }
  .sidebar-caption,
  .step small {
    display: none;
  }
  .steps {
    display: flex;
    flex-wrap: wrap;
  }
  .step {
    width: auto;
    padding: 0.45rem;
    align-items: center;
  }
  .step strong {
    font-size: 0.75rem;
  }
  .step-number {
    width: 1.3rem;
    height: 1.3rem;
    font-size: 0.68rem;
  }
  .sidebar-bottom {
    display: flex;
    gap: 0.5rem;
    margin: 0;
    padding: 0.4rem 0 0;
    border: 0;
  }
  .sidebar-bottom button {
    width: auto;
  }
  .content {
    padding: 1rem 0.7rem 1.8rem;
  }
  .project-bar {
    flex-wrap: wrap;
  }
  .more-actions[open] .more-buttons {
    left: 0;
    right: auto;
  }
  .preview {
    display: block;
    padding: 1rem;
  }
  .mini-sheet {
    max-width: 230px;
  }
}
@page {
  size: A4 landscape;
  margin: 0;
}
@media print {
  :global(html),
  :global(body),
  :global(#app) {
    width: 296mm;
    height: 209mm;
    margin: 0;
    padding: 0;
  }
  .topbar,
  .sidebar,
  .preview,
  .content > :not(.print-host) {
    display: none !important;
  }
  .app-layout,
  .content {
    display: block;
    width: 296mm;
    height: 209mm;
    min-height: 0;
    max-width: none;
    margin: 0;
    padding: 0;
  }
  .print-host {
    display: block !important;
    width: 296mm;
    height: 209mm;
    margin: 0 !important;
    padding: 0;
    border: 0;
    border-radius: 0;
    box-shadow: none;
  }
  .app-shell {
    width: 296mm;
    height: 209mm;
    min-height: 0;
    background: white;
  }
}
</style>
