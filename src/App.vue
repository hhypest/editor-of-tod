<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import LocalRegistries from './components/LocalRegistries.vue'
import ImportedData from './components/ImportedData.vue'
import LocalProjects from './components/LocalProjects.vue'
import NewScheme from './components/NewScheme.vue'
import PlacementEditor from './components/PlacementEditor.vue'
import Pu66Linker from './components/Pu66Linker.vue'
import SchemeDraftSheet from './components/SchemeDraftSheet.vue'
import SchemeReview from './components/SchemeReview.vue'
import SchemeWorkspace from './components/SchemeWorkspace.vue'
import SchemeDetailsEditor from './components/SchemeDetailsEditor.vue'
import TemplateChoice from './components/TemplateChoice.vue'
import ProjectDataInspector from './components/ProjectDataInspector.vue'
import {
  exportSchemeJson,
  importSchemeJson,
  MAX_PROJECT_FILE_BYTES,
  SchemeImportError,
  type ImportResult,
} from './domain/import'
import type { Scheme } from './domain/model'
import { schemeSchema } from './domain/model'
import { reviewScheme, type ReviewFinding } from './domain/review-scheme'
import { getLocalProject, restoreLocalRevision, saveLocalProject } from './services/local-projects'
import {
  recordEdit,
  redoEdit,
  startHistory,
  undoEdit,
  type EditHistory,
} from './domain/edit-history'

const imported = ref<ImportResult | null>(null)
const selectedFileName = ref('')
const errorMessage = ref('')
const loading = ref(false)
const detailsDirty = ref(false)
const placementDirty = ref(false)
const modifiedSinceDownload = ref(false)
const modifiedSinceLocalSave = ref(false)
const localRevision = ref<number | null>(null)
const localBusy = ref(false)
const localError = ref('')
const localNotice = ref('')
const projectsRefreshKey = ref(0)
const signCatalogVersion = ref(0)
const history = ref<EditHistory<Scheme> | null>(null)
const selectedPlacementId = ref<number | null>(null)
type View = 'projects' | 'source' | 'geometry' | 'objects' | 'review' | 'registries'
const stages = ['source', 'geometry', 'objects', 'review'] as const
const activeView = ref<View>('projects')
const projectTab = ref<'new' | 'file' | 'local'>('new')
const registryTab = ref<'imports' | 'entries'>('imports')
const registriesVisited = ref(false)
const setupStatus = ref<{ cards: number; signs: number } | null>(null)
const setupError = ref('')
const editorDirty = computed(() => detailsDirty.value || placementDirty.value)
const hasUnsavedWork = computed(
  () => editorDirty.value || (modifiedSinceDownload.value && modifiedSinceLocalSave.value),
)

function beforeUnload(event: BeforeUnloadEvent): void {
  if (hasUnsavedWork.value) event.preventDefault()
}

onMounted(() => {
  window.addEventListener('beforeunload', beforeUnload)
  void refreshSetupStatus()
})
onUnmounted(() => window.removeEventListener('beforeunload', beforeUnload))

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

async function openSetupImport(target: 'sign-import' | 'pu66-import'): Promise<void> {
  registryTab.value = 'imports'
  showView('registries')
  await nextTick()
  document.getElementById(target)?.scrollIntoView({ block: 'start' })
}

function onSignsUpdated(): void {
  signCatalogVersion.value++
  void refreshSetupStatus()
}

const fillCount = computed(() =>
  imported.value
    ? reviewScheme(imported.value.scheme).filter((finding) => finding.kind === 'fill').length
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
  Array.from(
    new Set(
      imported.value?.scheme.placements.flatMap((placement) =>
        placement.kind === 'sign-post' ? placement.signIds : [],
      ) ?? [],
    ),
  ),
)

function showView(view: View): void {
  if (!imported.value && stages.includes(view as (typeof stages)[number])) return
  if (view === 'registries') registriesVisited.value = true
  activeView.value = view
}

async function navigateToFinding(finding: ReviewFinding): Promise<void> {
  let view: View = 'review'
  if (finding.target === '#pu66-link-title' || finding.id === 'place') view = 'source'
  else if (finding.target === '#placements-title') view = 'objects'
  else if (finding.target === '#imported-title') {
    view = 'registries'
    registryTab.value = 'imports'
  } else if (
    finding.id.startsWith('distance-') ||
    ['figure-dimensions', 'variant-front', 'boundary-30'].includes(finding.id)
  )
    view = 'geometry'
  showView(view)
  await nextTick()
  document.getElementById(finding.target.slice(1))?.scrollIntoView({ block: 'start' })
}

async function onFileSelected(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  if (
    hasUnsavedWork.value &&
    !window.confirm('Есть правки без сохранённой копии. Открыть другой проект?')
  )
    return

  imported.value = null
  history.value = null
  selectedPlacementId.value = null
  detailsDirty.value = false
  placementDirty.value = false
  modifiedSinceDownload.value = false
  modifiedSinceLocalSave.value = false
  localRevision.value = null
  localError.value = ''
  localNotice.value = ''
  errorMessage.value = ''
  selectedFileName.value = file.name

  if (file.size > MAX_PROJECT_FILE_BYTES) {
    errorMessage.value = 'Файл проекта больше 32 МБ.'
    return
  }

  loading.value = true
  try {
    imported.value = importSchemeJson(await file.text())
    history.value = startHistory(imported.value.scheme)
    selectedPlacementId.value = imported.value.scheme.placements[0]?.id ?? null
    showView('source')
  } catch (error) {
    errorMessage.value =
      error instanceof SchemeImportError ? error.message : 'Не удалось прочитать выбранный файл.'
  } finally {
    loading.value = false
  }
}

function downloadJson(content: string, suffix: string): void {
  const scheme = imported.value?.scheme
  if (!scheme) return

  const crossing = scheme.crossing.referenceId.replace(/[^\p{L}\p{N}_-]/gu, '_').slice(0, 60)
  const url = URL.createObjectURL(new Blob([content], { type: 'application/json;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = `scheme_${crossing || 'crossing'}_${suffix}.json`
  document.body.append(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000)
}

function saveV4(): void {
  if (imported.value && !editorDirty.value) {
    downloadJson(exportSchemeJson(imported.value.scheme), 'v4')
    modifiedSinceDownload.value = false
  }
}

function saveOriginal(): void {
  if (imported.value?.scheme.source.kind === 'legacy-html-v1') {
    downloadJson(imported.value.scheme.source.originalJson, 'original_v1')
  }
}

function createProject(scheme: Scheme): void {
  if (
    hasUnsavedWork.value &&
    !window.confirm('Есть правки без сохранённой копии. Создать другой проект?')
  )
    return
  imported.value = {
    scheme,
    format: 'scheme-v4',
    warnings: [
      'Идентификатор переезда введён вручную; карточка ПУ-66 не сверена.',
      'Вариант выбран по длине фронта работ, нормативная проверка и расстановка знаков не выполнены.',
      ...(scheme.parameters.workZones[scheme.template.code]?.workMetres === 30
        ? ['Ровно 30 м: требуется предметная сверка применимости варианта.']
        : []),
    ],
  }
  history.value = startHistory(scheme)
  selectedPlacementId.value = null
  selectedFileName.value = 'Новый проект · не сохранён'
  localRevision.value = null
  detailsDirty.value = false
  placementDirty.value = false
  modifiedSinceDownload.value = true
  modifiedSinceLocalSave.value = true
  localError.value = ''
  localNotice.value = ''
  errorMessage.value = ''
  showView('source')
}

function showLocalError(cause: unknown): void {
  localError.value =
    cause instanceof Error ? cause.message : 'Операция с локальной базой не удалась.'
  if (localError.value.includes('Запись изменилась')) {
    localError.value += ' Ваши правки остались открытыми. Обновите список черновиков.'
    if (localRevision.value === null) {
      localError.value += ' Для отдельной копии используйте «Сохранить как новый черновик».'
    }
  }
}

async function saveLocally(): Promise<void> {
  if (!imported.value || editorDirty.value || localBusy.value) return
  localBusy.value = true
  localError.value = ''
  localNotice.value = ''
  try {
    const schemeAtSave = imported.value.scheme
    const saved = await saveLocalProject(schemeAtSave, localRevision.value ?? 0)
    localRevision.value = saved.revision
    if (imported.value.scheme === schemeAtSave) modifiedSinceLocalSave.value = false
    projectsRefreshKey.value++
    localNotice.value = `Черновик сохранён в SQLite: редакция № ${saved.revision}.`
  } catch (cause) {
    showLocalError(cause)
  } finally {
    localBusy.value = false
  }
}

async function saveAsNew(): Promise<void> {
  if (!imported.value || editorDirty.value || localBusy.value) return
  localBusy.value = true
  localError.value = ''
  localNotice.value = ''
  try {
    const copy = schemeSchema.parse({
      ...imported.value.scheme,
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
    })
    const saved = await saveLocalProject(copy, 0)
    imported.value = { ...imported.value, scheme: saved.scheme }
    history.value = startHistory(saved.scheme)
    localRevision.value = saved.revision
    modifiedSinceLocalSave.value = false
    modifiedSinceDownload.value = true
    selectedFileName.value = `Локальный черновик · редакция № ${saved.revision}`
    projectsRefreshKey.value++
    localNotice.value = 'Создан отдельный черновик с новым ID. Скачайте его JSON при необходимости.'
  } catch (cause) {
    showLocalError(cause)
  } finally {
    localBusy.value = false
  }
}

function openProjectRecord(scheme: Scheme, revision: number): void {
  imported.value = {
    scheme,
    format: 'scheme-v4',
    warnings: ['Схема не прошла нормативную проверку.'],
  }
  history.value = startHistory(scheme)
  selectedPlacementId.value = scheme.placements[0]?.id ?? null
  selectedFileName.value = `Локальный черновик · редакция № ${revision}`
  localRevision.value = revision
  detailsDirty.value = false
  placementDirty.value = false
  modifiedSinceDownload.value = false
  modifiedSinceLocalSave.value = false
  showView('source')
}

async function openLocal(id: string): Promise<void> {
  if (localBusy.value || loading.value) return
  if (
    hasUnsavedWork.value &&
    !window.confirm('Есть правки без сохранённой копии. Открыть черновик?')
  )
    return
  localBusy.value = true
  localError.value = ''
  localNotice.value = ''
  try {
    const record = await getLocalProject(id)
    openProjectRecord(record.scheme, record.revision)
  } catch (cause) {
    showLocalError(cause)
  } finally {
    localBusy.value = false
  }
}

async function restoreLocal(
  id: string,
  sourceRevision: number,
  expectedRevision: number,
): Promise<void> {
  if (
    localBusy.value ||
    imported.value?.scheme.id !== id ||
    localRevision.value !== expectedRevision
  )
    return
  if (
    !window.confirm(
      `Восстановить редакцию № ${sourceRevision} как новую редакцию проекта? Несохранённые правки в открытой вкладке будут заменены; сохранённая текущая редакция останется в истории.`,
    )
  )
    return
  localBusy.value = true
  localError.value = ''
  localNotice.value = ''
  try {
    const record = await restoreLocalRevision(id, sourceRevision, expectedRevision)
    openProjectRecord(record.scheme, record.revision)
    projectsRefreshKey.value++
    localNotice.value = `Редакция № ${sourceRevision} восстановлена как № ${record.revision}.`
  } catch (cause) {
    showLocalError(cause)
  } finally {
    localBusy.value = false
  }
}

function onProjectApplied(scheme: Scheme): void {
  if (!imported.value) return
  history.value = recordEdit(history.value ?? startHistory(imported.value.scheme), scheme)
  imported.value = { ...imported.value, scheme }
  detailsDirty.value = false
  placementDirty.value = false
  modifiedSinceDownload.value = true
  modifiedSinceLocalSave.value = true
}

function onPu66Linked(scheme: Scheme): void {
  onProjectApplied(scheme)
  if (!imported.value) return
  imported.value = {
    ...imported.value,
    warnings: [
      ...imported.value.warnings.filter(
        (warning) =>
          warning !== 'Идентификатор переезда введён вручную; карточка ПУ-66 не сверена.' &&
          !warning.startsWith('Локальная карточка ПУ-66 закреплена'),
      ),
      'Локальная карточка ПУ-66 закреплена как снимок; её актуальность нужно проверить.',
    ],
  }
}

function stepBack(): void {
  if (!imported.value || !history.value || editorDirty.value || !history.value.past.length) return
  history.value = undoEdit(history.value)
  imported.value = { ...imported.value, scheme: history.value.present }
  modifiedSinceDownload.value = true
  modifiedSinceLocalSave.value = true
}

function stepForward(): void {
  if (!imported.value || !history.value || editorDirty.value || !history.value.future.length) return
  history.value = redoEdit(history.value)
  imported.value = { ...imported.value, scheme: history.value.present }
  modifiedSinceDownload.value = true
  modifiedSinceLocalSave.value = true
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
          {{
            editorDirty
              ? 'Есть неприменённый ввод'
              : modifiedSinceLocalSave
                ? 'Есть несохранённые правки'
                : localRevision === null
                  ? 'Не сохранён в SQLite'
                  : 'Черновик сохранён'
          }}
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
          v-if="imported"
          type="button"
          class="top-save"
          :disabled="editorDirty || localBusy"
          @click="saveLocally"
        >
          Сохранить локально
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
            :class="{ selected: activeView === 'projects' }"
            @click="showView('projects')"
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
        </div>
      </aside>

      <div class="content">
        <p v-if="localError" class="feedback error" role="alert">{{ localError }}</p>
        <p v-if="localNotice" class="feedback notice" role="status">{{ localNotice }}</p>

        <section v-show="activeView === 'projects'" class="view" aria-labelledby="projects-heading">
          <div class="view-heading">
            <p class="eyebrow">Рабочее место</p>
            <h1 id="projects-heading">Проекты схем</h1>
            <p>
              Создайте новую схему, откройте сохранённую редакцию или загрузите прежний JSON-проект.
            </p>
          </div>
          <section
            v-if="setupStatus && (!setupStatus.signs || !setupStatus.cards)"
            class="setup-guide module"
            aria-labelledby="setup-heading"
          >
            <p class="eyebrow">Первый запуск · локальная SQLite готова</p>
            <h2 id="setup-heading">Наполните реестры на этом компьютере</h2>
            <p>
              Локальная база находится в private-data/registry.sqlite. Добавьте недостающие реестры
              из своего ZIP со знаками и книг ПУ-66. Файлы выбираются с этого компьютера; после
              просмотра изменений подтвердите запись.
            </p>
            <ol class="setup-steps">
              <li>
                <strong
                  >Знаки:
                  {{ setupStatus.signs ? `${setupStatus.signs} в базе` : 'пока нет' }}</strong
                >
                <p>Укажите архив PNG и редакцию ГОСТ.</p>
                <button type="button" @click="openSetupImport('sign-import')">
                  {{ setupStatus.signs ? 'Открыть каталог' : 'Импортировать ZIP знаков' }}
                </button>
              </li>
              <li>
                <strong
                  >ПУ-66:
                  {{ setupStatus.cards ? `${setupStatus.cards} в базе` : 'пока нет' }}</strong
                >
                <p>
                  Выберите до четырёх XLSX; для пробы можно создать вымышленные книги командой npm
                  run samples:pu66.
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
            <button type="button" :aria-pressed="projectTab === 'new'" @click="projectTab = 'new'">
              Новый проект
            </button>
            <button
              type="button"
              :aria-pressed="projectTab === 'local'"
              @click="projectTab = 'local'"
            >
              Черновики SQLite
            </button>
            <button
              type="button"
              :aria-pressed="projectTab === 'file'"
              @click="projectTab = 'file'"
            >
              Открыть JSON
            </button>
          </div>
          <NewScheme
            v-show="projectTab === 'new'"
            class="module"
            :locked="localBusy || loading"
            @create="createProject"
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
              Поддерживаются v1 и schemaVersion 2, 3, 4 размером до 32 МБ. Открытие само по себе не
              записывает файл в SQLite.
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
            <p>Карточки ПУ-66 и каталог знаков остаются в базе на этом компьютере.</p>
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
              :aria-pressed="registryTab === 'entries'"
              @click="registryTab = 'entries'"
            >
              Карточки и нормативы
            </button>
          </div>
          <ImportedData
            v-show="registryTab === 'imports'"
            class="module"
            :referenced-sign-ids="referencedSignIds"
            :locked="editorDirty"
            @signs-updated="onSignsUpdated"
            @pu66-updated="refreshSetupStatus"
          />
          <LocalRegistries v-show="registryTab === 'entries'" class="module" />
        </section>

        <template v-if="imported">
          <div
            v-show="activeView !== 'projects' && activeView !== 'registries'"
            class="project-bar"
          >
            <div>
              <span class="eyebrow">{{ selectedFileName }}</span
              ><strong
                >Переезд {{ imported.scheme.crossing.referenceId }} ·
                {{ imported.scheme.template.code.toUpperCase() }}</strong
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
                  Сохранить как новый черновик
                </button>
                <button type="button" :disabled="editorDirty || localBusy" @click="saveV4">
                  Скачать JSON v4
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
          <p
            v-show="activeView !== 'projects' && activeView !== 'registries' && editorDirty"
            class="feedback pending"
            role="status"
          >
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
              ><strong>{{ imported.scheme.template.code.toUpperCase() }}</strong
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
              @apply="onProjectApplied"
              @dirty="placementDirty = $event"
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
              @navigate="navigateToFinding"
            />
          </section>

          <SchemeDetailsEditor
            v-show="activeView === 'source' || activeView === 'geometry' || activeView === 'review'"
            class="module details-module"
            :scheme="imported.scheme"
            :mode="detailsMode"
            :locked="placementDirty || localBusy"
            @apply="onProjectApplied"
            @dirty="detailsDirty = $event"
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

          <nav
            v-show="activeView !== 'projects' && activeView !== 'registries'"
            class="stage-controls"
            aria-label="Переход между этапами"
          >
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
            ><span class="variant-badge">{{ imported.scheme.template.code.toUpperCase() }}</span>
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
  :global(body *) {
    visibility: hidden !important;
  }
  .print-host,
  .print-host :deep(*) {
    visibility: visible !important;
  }
  .print-host {
    display: block !important;
    position: absolute;
    top: 0;
    left: 0;
    width: 297mm;
    height: 210mm;
    margin: 0;
    padding: 0;
    border: 0;
    border-radius: 0;
    box-shadow: none;
  }
  .app-shell {
    min-height: 0;
    background: white;
  }
}
</style>
