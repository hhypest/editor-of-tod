<script setup lang="ts">
import { computed, ref } from 'vue'
import {
  exportSchemeJson,
  importSchemeJson,
  MAX_PROJECT_FILE_BYTES,
  SchemeImportError,
  type ImportResult,
} from './domain/import'

const imported = ref<ImportResult | null>(null)
const selectedFileName = ref('')
const errorMessage = ref('')
const loading = ref(false)

const signCount = computed(() =>
  imported.value?.scheme.placements.reduce(
    (count, placement) => count + (placement.kind === 'sign-post' ? placement.signIds.length : 0),
    0,
  ),
)

async function onFileSelected(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return

  imported.value = null
  errorMessage.value = ''
  selectedFileName.value = file.name

  if (file.size > MAX_PROJECT_FILE_BYTES) {
    errorMessage.value = 'Файл проекта больше 10 МБ.'
    return
  }

  loading.value = true
  try {
    imported.value = importSchemeJson(await file.text())
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
  if (imported.value) downloadJson(exportSchemeJson(imported.value.scheme), 'v2')
}

function saveOriginal(): void {
  if (imported.value) downloadJson(imported.value.scheme.source.originalJson, 'original_v1')
}
</script>

<template>
  <main class="page">
    <div class="shell">
      <header>
        <p class="eyebrow">Редактор СОДД · этап миграции</p>
        <h1>Импорт проекта переезда</h1>
        <p class="lead">
          Откройте JSON-проект автономного редактора. Приложение проверит структуру файла и создаст
          копию в новом формате с сохранением исходных данных.
        </p>
      </header>

      <section class="panel" aria-labelledby="import-title">
        <h2 id="import-title">Выбрать проект</h2>
        <label for="scheme-file" class="file-label">Файл проекта .json</label>
        <input
          id="scheme-file"
          type="file"
          accept=".json,application/json"
          @change="onFileSelected"
        />
        <p class="hint">
          Поддерживаются файлы старого редактора <code>v: 1</code> и проекты
          <code>schemaVersion: 2</code> размером до 10 МБ.
        </p>
        <p v-if="loading" class="hint" role="status">Проверяем файл…</p>
        <p v-if="errorMessage" class="error" role="alert">{{ errorMessage }}</p>
      </section>

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

        <h3>Что нужно проверить</h3>
        <ul>
          <li v-for="warning in imported.warnings" :key="warning">{{ warning }}</li>
        </ul>

        <div class="actions">
          <button type="button" class="primary" @click="saveV2">Сохранить копию v2</button>
          <button type="button" @click="saveOriginal">Скачать исходный JSON</button>
        </div>
        <p class="hint">
          Исходный файл не изменяется. Редактирование листа, каталог знаков и печать появятся на
          следующих этапах.
        </p>
      </section>
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
  max-width: 58rem;
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

button:hover,
button:focus-visible {
  outline: 2px solid #185ca5;
  outline-offset: 2px;
}
</style>
