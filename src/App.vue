<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import LocalRegistries from './components/LocalRegistries.vue'
import ImportedData from './components/ImportedData.vue'
import LocalProjects from './components/LocalProjects.vue'
import PlacementEditor from './components/PlacementEditor.vue'
import SchemeWorkspace from './components/SchemeWorkspace.vue'
import SchemeDetailsEditor from './components/SchemeDetailsEditor.vue'
import TemplateChoice from './components/TemplateChoice.vue'
import {
  exportSchemeJson,
  importSchemeJson,
  MAX_PROJECT_FILE_BYTES,
  SchemeImportError,
  type ImportResult,
} from './domain/import'
import type { Scheme } from './domain/model'
import { schemeSchema } from './domain/model'
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
const history = ref<EditHistory<Scheme> | null>(null)
const selectedPlacementId = ref<number | null>(null)
const editorDirty = computed(() => detailsDirty.value || placementDirty.value)
const hasUnsavedWork = computed(
  () => editorDirty.value || (modifiedSinceDownload.value && modifiedSinceLocalSave.value),
)

function beforeUnload(event: BeforeUnloadEvent): void {
  if (hasUnsavedWork.value) event.preventDefault()
}

onMounted(() => window.addEventListener('beforeunload', beforeUnload))
onUnmounted(() => window.removeEventListener('beforeunload', beforeUnload))

const signCount = computed(() =>
  imported.value?.scheme.placements.reduce(
    (count, placement) => count + (placement.kind === 'sign-post' ? placement.signIds.length : 0),
    0,
  ),
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

function formatMetres(value: number | null): string {
  return value === null ? 'не указано' : `${value} м`
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
    errorMessage.value = 'Файл проекта больше 10 МБ.'
    return
  }

  loading.value = true
  try {
    imported.value = importSchemeJson(await file.text())
    history.value = startHistory(imported.value.scheme)
    selectedPlacementId.value = imported.value.scheme.placements[0]?.id ?? null
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

function saveV2(): void {
  if (imported.value && !editorDirty.value) {
    downloadJson(exportSchemeJson(imported.value.scheme), 'v2')
    modifiedSinceDownload.value = false
  }
}

function saveOriginal(): void {
  if (imported.value) downloadJson(imported.value.scheme.source.originalJson, 'original_v1')
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
    format: 'scheme-v2',
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
  <main class="page">
    <div class="shell">
      <header>
        <p class="eyebrow">Редактор СОДД · локальный проект</p>
        <h1>Проект переезда</h1>
        <p class="lead">
          Откройте JSON-проект автономного редактора. Проверьте перенесённые данные, измените
          параметры и объекты, затем сохраните черновик на этом компьютере или скачайте JSON-копию.
        </p>
      </header>

      <section class="panel" aria-labelledby="import-title">
        <h2 id="import-title">Выбрать проект</h2>
        <label for="scheme-file" class="file-label">Файл проекта .json</label>
        <input
          id="scheme-file"
          type="file"
          accept=".json,application/json"
          :disabled="localBusy"
          @change="onFileSelected"
        />
        <p class="hint">
          Поддерживаются файлы старого редактора <code>v: 1</code> и проекты
          <code>schemaVersion: 2</code> размером до 10 МБ.
        </p>
        <p v-if="loading" class="hint" role="status">Проверяем файл…</p>
        <p v-if="errorMessage" class="error" role="alert">{{ errorMessage }}</p>
      </section>

      <LocalProjects
        class="panel"
        :active-id="imported?.scheme.id ?? null"
        :active-revision="localRevision"
        :refresh-key="projectsRefreshKey"
        :locked="localBusy || loading"
        @open="openLocal"
        @restore="restoreLocal"
      />

      <section
        v-if="imported"
        class="panel result"
        aria-labelledby="result-title"
        aria-live="polite"
      >
        <div class="result-heading">
          <div>
            <p class="eyebrow">
              {{ imported.format === 'legacy-v1' ? 'Старый формат v1' : 'Новый формат v2' }}
            </p>
            <h2 id="result-title">Структура проекта проверена</h2>
          </div>
          <span class="badge">Без нормативной проверки</span>
        </div>

        <dl>
          <div>
            <dt>Файл</dt>
            <dd>{{ selectedFileName }}</dd>
          </div>
          <div>
            <dt>Переезд из файла</dt>
            <dd>{{ imported.scheme.crossing.referenceId }}</dd>
          </div>
          <div>
            <dt>Вариант</dt>
            <dd>{{ imported.scheme.template.code.toUpperCase() }}</dd>
          </div>
          <div>
            <dt>Объектов на листе</dt>
            <dd>{{ imported.scheme.placements.length }}</dd>
          </div>
          <div>
            <dt>Указаний знаков</dt>
            <dd>{{ signCount }}</dd>
          </div>
        </dl>

        <h3>Предупреждения при импорте</h3>
        <ul>
          <li v-for="warning in imported.warnings" :key="warning">{{ warning }}</li>
        </ul>

        <div class="actions">
          <button
            type="button"
            class="primary"
            :disabled="editorDirty || localBusy"
            @click="saveLocally"
          >
            Сохранить локально
          </button>
          <button type="button" :disabled="editorDirty || localBusy" @click="saveAsNew">
            Сохранить как новый черновик
          </button>
          <button
            type="button"
            class="primary"
            :disabled="editorDirty || localBusy"
            @click="saveV2"
          >
            Сохранить копию v2
          </button>
          <button type="button" @click="saveOriginal">Скачать исходный JSON</button>
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
        <p v-if="localError" class="error" role="alert">{{ localError }}</p>
        <p v-if="localNotice" class="hint" role="status">{{ localNotice }}</p>
        <p v-if="localRevision !== null" class="hint">
          Открыта локальная редакция № {{ localRevision
          }}{{ modifiedSinceLocalSave ? ' · есть новые правки' : '' }}.
        </p>
        <p v-if="editorDirty" class="hint" role="status">
          Сначала примените или отмените изменения в форме, затем скачайте копию проекта или
          воспользуйтесь историей действий.
        </p>
        <p v-else-if="modifiedSinceDownload" class="hint" role="status">
          {{
            modifiedSinceLocalSave
              ? 'Применённые правки находятся в памяти браузера. Сохраните локально или скачайте JSON-копию.'
              : 'Черновик сохранён локально. Для отдельной копии скачайте JSON v2.'
          }}
        </p>
        <p class="hint">
          Исходный файл не изменяется. Рабочая область показывает условные координаты объектов;
          печатный лист появится на следующем этапе.
        </p>
      </section>

      <SchemeDetailsEditor
        v-if="imported"
        class="panel"
        :scheme="imported.scheme"
        :locked="placementDirty || localBusy"
        @apply="onProjectApplied"
        @dirty="detailsDirty = $event"
      />

      <SchemeWorkspace
        v-if="imported"
        class="panel"
        :scheme="imported.scheme"
        :selected-id="selectedPlacementId"
        :locked="editorDirty || localBusy"
        @apply="onProjectApplied"
        @select="selectedPlacementId = $event"
      />

      <PlacementEditor
        v-if="imported"
        class="panel"
        :scheme="imported.scheme"
        :locked="detailsDirty || localBusy"
        :selected-placement-id="selectedPlacementId"
        @apply="onProjectApplied"
        @dirty="placementDirty = $event"
        @select="selectedPlacementId = $event"
      />

      <section v-if="imported" class="panel" aria-labelledby="inspection-title">
        <h2 id="inspection-title">Сверка перенесённых данных</h2>
        <p class="hint">
          Значения показаны из файла без проверки нормативов. Координаты объектов приведены в
          условных единицах прежнего листа, расстояния — в метрах. Коды привязки и стороны сохранены
          из проекта.
        </p>

        <h3>Параметры</h3>
        <dl>
          <div>
            <dt>Участок</dt>
            <dd>{{ imported.scheme.parameters.locationText || 'не указано' }}</dd>
          </div>
          <div>
            <dt>Направления</dt>
            <dd>
              {{ imported.scheme.parameters.directions.left }} /
              {{ imported.scheme.parameters.directions.right }}
            </dd>
          </div>
          <div>
            <dt>Расстояния d300 / d250 / d150 / d50</dt>
            <dd>
              {{ formatMetres(imported.scheme.parameters.signDistancesMetres.d300) }} /
              {{ formatMetres(imported.scheme.parameters.signDistancesMetres.d250) }} /
              {{ formatMetres(imported.scheme.parameters.signDistancesMetres.d150) }} /
              {{ formatMetres(imported.scheme.parameters.signDistancesMetres.d50) }}
            </dd>
          </div>
          <div>
            <dt>Ступени скорости</dt>
            <dd>{{ imported.scheme.parameters.speedStagesKmh.join(' / ') }} км/ч</dd>
          </div>
          <div>
            <dt>Жёлтый фон временных знаков</dt>
            <dd>{{ imported.scheme.parameters.yellowTemporarySigns ? 'да' : 'нет' }}</dd>
          </div>
          <div>
            <dt>Б.33: отвод / буфер / зона работ</dt>
            <dd>
              {{ imported.scheme.parameters.workZones.b33.taperMetres }} /
              {{ imported.scheme.parameters.workZones.b33.bufferMetres }} /
              {{ imported.scheme.parameters.workZones.b33.workMetres }} м
            </dd>
          </div>
          <div>
            <dt>Б.34: отвод / буфер / зона работ</dt>
            <dd>
              {{ imported.scheme.parameters.workZones.b34.taperMetres }} /
              {{ imported.scheme.parameters.workZones.b34.bufferMetres }} /
              {{ imported.scheme.parameters.workZones.b34.workMetres }} м
            </dd>
          </div>
        </dl>

        <details>
          <summary>Реквизиты из исходного проекта</summary>
          <dl>
            <div>
              <dt>Разработчик</dt>
              <dd>
                {{ imported.scheme.titleBlock.developer.organization }} ·
                {{ imported.scheme.titleBlock.developer.name }} ·
                {{ imported.scheme.titleBlock.developer.date }}
              </dd>
            </div>
            <div>
              <dt>Работы</dt>
              <dd>
                {{ imported.scheme.titleBlock.work.organization }} ·
                {{ imported.scheme.titleBlock.work.description }} ·
                {{ imported.scheme.titleBlock.work.period }}
              </dd>
            </div>
            <div>
              <dt>Ответственные</dt>
              <dd>{{ imported.scheme.titleBlock.responsible.join(' · ') }}</dd>
            </div>
            <div>
              <dt>Утверждение</dt>
              <dd>
                {{ imported.scheme.titleBlock.approver.position }} ·
                {{ imported.scheme.titleBlock.approver.organization }} ·
                {{ imported.scheme.titleBlock.approver.name }}
              </dd>
            </div>
            <div>
              <dt>Согласование (текст из файла)</dt>
              <dd>
                {{ imported.scheme.titleBlock.agreement.position }} ·
                {{ imported.scheme.titleBlock.agreement.name }} ·
                {{ imported.scheme.titleBlock.agreement.year }}
              </dd>
            </div>
          </dl>
        </details>

        <h3>Объекты на листе</h3>
        <p v-if="imported.scheme.placements.length === 0" class="hint">Объектов нет.</p>
        <div v-else class="table-scroll">
          <table>
            <caption>
              Состав и координаты объектов, сохранённые при переносе
            </caption>
            <thead>
              <tr>
                <th scope="col">ID</th>
                <th scope="col">Тип и содержимое</th>
                <th scope="col">Положение в условных координатах</th>
                <th scope="col">Параметры стойки</th>
                <th scope="col">Происхождение</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="placement in imported.scheme.placements" :key="placement.id">
                <td>{{ placement.id }}</td>
                <td>
                  <template v-if="placement.kind === 'sign-post'">
                    Стойка: {{ placement.signIds.join(', ') }}
                    <small v-if="placement.distanceLabel">{{ placement.distanceLabel }}</small>
                  </template>
                  <template v-else>
                    Элемент {{ placement.elementKind }}
                    <small v-if="placement.text">{{ placement.text }}</small>
                  </template>
                </td>
                <td>
                  {{ placement.position.anchor }}; x={{ placement.position.offsetXSvg }}; y={{
                    placement.kind === 'sign-post'
                      ? placement.position.offsetYSvg
                      : placement.position.ySvg
                  }}
                </td>
                <td v-if="placement.kind === 'sign-post'">
                  сторона {{ placement.side }}; опора {{ placement.stand }}
                </td>
                <td v-else>—</td>
                <td>{{ placement.generatedByTemplate ? 'автоматически' : 'вручную' }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
      <TemplateChoice />
      <LocalRegistries />
      <ImportedData :referenced-sign-ids="referencedSignIds" />
    </div>
  </main>
</template>

<style scoped>
.page {
  min-height: 100vh;
  padding: clamp(1.5rem, 5vw, 4rem) 1.25rem;
  background: #f3f6fa;
  color: #192534;
  font-family:
    system-ui,
    -apple-system,
    'Segoe UI',
    sans-serif;
}

.shell {
  max-width: 68rem;
  margin: 0 auto;
}

h1 {
  margin: 0.4rem 0 1rem;
  font-size: clamp(2rem, 4vw, 3.2rem);
  line-height: 1.15;
}

h2 {
  margin: 0 0 1rem;
  font-size: 1.4rem;
}

h3 {
  margin: 1.75rem 0 0.5rem;
  font-size: 1rem;
}

.lead {
  max-width: 45rem;
  margin-bottom: 2rem;
  font-size: 1.15rem;
  line-height: 1.6;
}

.eyebrow {
  margin: 0;
  color: #175c9e;
  font-weight: 700;
  letter-spacing: 0.02em;
}

.panel {
  margin: 1rem 0;
  padding: clamp(1.25rem, 4vw, 2rem);
  background: #fff;
  border: 1px solid #d8e1eb;
  border-radius: 0.8rem;
  box-shadow: 0 3px 14px rgb(19 46 75 / 5%);
}

.file-label {
  display: block;
  margin-bottom: 0.5rem;
  font-weight: 600;
}

input[type='file'] {
  display: block;
  max-width: 100%;
  font: inherit;
}

.hint {
  color: #526273;
  font-size: 0.9rem;
  line-height: 1.5;
}

.error {
  color: #a22030;
  font-weight: 600;
}

.result-heading {
  display: flex;
  gap: 1rem;
  align-items: flex-start;
  justify-content: space-between;
  flex-wrap: wrap;
}

.badge {
  padding: 0.35rem 0.65rem;
  border-radius: 0.5rem;
  background: #fff1da;
  color: #69420b;
  font-size: 0.85rem;
  font-weight: 600;
}

dl {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr));
  gap: 1rem;
  margin: 1.25rem 0;
}

dt {
  color: #526273;
  font-size: 0.85rem;
}

dd {
  margin: 0.3rem 0 0;
  overflow-wrap: anywhere;
  font-weight: 600;
}

li {
  margin-bottom: 0.4rem;
  line-height: 1.5;
}

details {
  margin-top: 1.5rem;
}

summary {
  cursor: pointer;
  font-weight: 600;
}

.table-scroll {
  overflow-x: auto;
}

table {
  width: 100%;
  border-collapse: collapse;
  text-align: left;
}

caption {
  margin-bottom: 0.5rem;
  color: #526273;
  font-size: 0.85rem;
  text-align: left;
}

th,
td {
  padding: 0.75rem;
  border-bottom: 1px solid #d8e1eb;
  vertical-align: top;
}

th {
  white-space: nowrap;
}

small {
  display: block;
  margin-top: 0.25rem;
  color: #526273;
}

.actions {
  display: flex;
  gap: 0.7rem;
  flex-wrap: wrap;
  margin-top: 1.5rem;
}

button {
  padding: 0.7rem 1rem;
  border: 1px solid #185ca5;
  border-radius: 0.45rem;
  background: #fff;
  color: #185ca5;
  cursor: pointer;
  font: inherit;
  font-weight: 600;
}

button.primary {
  background: #185ca5;
  color: #fff;
}

button:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

button:hover,
button:focus-visible {
  outline: 2px solid #185ca5;
  outline-offset: 2px;
}
</style>
