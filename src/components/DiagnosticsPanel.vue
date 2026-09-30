<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { Scheme } from '../domain/model'
import { templateLabel } from '../domain/registry'
import {
  appBuild,
  clearDiagnostics,
  loadDiagnostics,
  type DiagnosticsReport,
} from '../services/diagnostics'

const props = defineProps<{
  /** Открытый проект: в отчёт попадает только его форма, без содержимого. */
  scheme: Scheme | null
  view: string
}>()

type EventRow = {
  at: string
  source: string
  kind: string
  name: string
  durationMs?: number
  status?: number
  message?: string
}

const report = ref<DiagnosticsReport | null>(null)
const error = ref('')
const notice = ref('')
const busy = ref(false)

const events = computed(() => (report.value?.events as EventRow[] | undefined) ?? [])
const problems = computed(() =>
  events.value
    .filter((event) => event.kind === 'error' || event.kind === 'slow')
    .slice(-10)
    .reverse(),
)
const database = computed(
  () => (report.value?.database as Record<string, unknown> | undefined) ?? null,
)

/** Форма открытого проекта без содержимого: ни ключа переезда, ни текстов, ни реквизитов. */
function projectShape(): Record<string, unknown> {
  const scheme = props.scheme
  if (!scheme) return { open: false }
  return {
    open: true,
    schemaVersion: scheme.schemaVersion,
    template: templateLabel(scheme.template.code),
    projectionVersion: scheme.template.projectionVersion,
    source: scheme.source.kind,
    crossingSource: scheme.crossing.source,
    placements: scheme.placements.length,
    signPosts: scheme.placements.filter((placement) => placement.kind === 'sign-post').length,
    generatedByTemplate: scheme.placements.filter((placement) => placement.generatedByTemplate)
      .length,
    yellowTemporarySigns: scheme.parameters.yellowTemporarySigns,
    location: scheme.parameters.location,
    signSize: scheme.parameters.signSize,
    regulationMode: scheme.parameters.regulation.mode,
    pinnedSignImages: Object.keys(scheme.signImages.revisions).length,
    reviewMarks: Object.keys(scheme.reviewMarks).length,
  }
}

async function refresh(): Promise<void> {
  error.value = ''
  try {
    report.value = await loadDiagnostics()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'Диагностика недоступна.'
  }
}

async function download(): Promise<void> {
  busy.value = true
  error.value = ''
  notice.value = ''
  try {
    const server = await loadDiagnostics()
    report.value = server
    const full = {
      ...server,
      build: appBuild,
      browser: {
        userAgent: navigator.userAgent,
        language: navigator.language,
        screen: `${screen.width}×${screen.height}`,
        viewport: `${window.innerWidth}×${window.innerHeight}`,
        devicePixelRatio: window.devicePixelRatio,
      },
      interface: { view: props.view, project: projectShape() },
    }
    const blob = new Blob([`${JSON.stringify(full, null, 2)}\n`], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `diagnostics_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1_000)
    notice.value = 'Файл диагностики сохранён. Просмотрите его перед отправкой разработчику.'
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'Не удалось сформировать файл.'
  } finally {
    busy.value = false
  }
}

async function clear(): Promise<void> {
  busy.value = true
  error.value = ''
  try {
    await clearDiagnostics()
    notice.value = 'Журнал диагностики очищен.'
    await refresh()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'Не удалось очистить журнал.'
  } finally {
    busy.value = false
  }
}

function when(iso: string): string {
  return new Date(iso).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'medium' })
}

onMounted(refresh)
</script>

<template>
  <section class="diagnostics" aria-labelledby="diagnostics-title">
    <h2 id="diagnostics-title">Диагностика</h2>
    <p class="hint">
      Редактор записывает ошибки, медленные операции и время долгих действий (импорт, извлечение
      знаков, выгрузка листа) в журнал рядом с базой. Файл диагностики помогает найти причину сбоя:
      приложите его к описанию проблемы. В него не попадают данные ПУ-66, содержимое проектов, ФИО и
      телефоны; из открытого проекта — только вариант, число объектов и режимы. Ничего не
      отправляется по сети автоматически.
    </p>
    <div class="actions">
      <button type="button" class="primary" :disabled="busy" @click="download">
        Скачать диагностику
      </button>
      <button type="button" :disabled="busy" @click="refresh">Обновить</button>
      <button type="button" :disabled="busy" @click="clear">Очистить журнал</button>
    </div>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p v-if="notice" class="notice" role="status">{{ notice }}</p>
    <dl v-if="report && database" class="summary">
      <dt>Версия</dt>
      <dd>
        {{ appBuild.version
        }}<template v-if="appBuild.commit !== 'unknown'"> · {{ appBuild.commit }}</template> ·
        сервер {{ (report.app as { mode: string }).mode }}
      </dd>
      <dt>База</dt>
      <dd>
        схема v{{ database.schemaVersion }}, {{ database.sizeKb }} КБ, карточек ПУ-66
        {{ database.pu66Cards }}, проектов {{ database.projects }}, резервных копий
        {{ database.backups }}
      </dd>
      <dt>Журнал</dt>
      <dd>
        событий {{ report.eventsTotal }}, из них ошибок и медленных операций
        {{ events.filter((event) => event.kind === 'error' || event.kind === 'slow').length }}
      </dd>
    </dl>
    <template v-if="problems.length">
      <h3>Последние ошибки и медленные операции</h3>
      <ul class="problems">
        <li v-for="(event, index) in problems" :key="index">
          <strong>{{ when(event.at) }}</strong> ·
          {{ event.source === 'client' ? 'интерфейс' : 'сервер' }} · {{ event.name
          }}<template v-if="event.status"> · {{ event.status }}</template
          ><template v-if="event.durationMs !== undefined">
            · {{ Math.round(event.durationMs) }} мс</template
          >
          <pre v-if="event.message">{{ event.message }}</pre>
        </li>
      </ul>
    </template>
    <p v-else-if="report" class="hint">Ошибок и медленных операций в журнале нет.</p>
  </section>
</template>

<style scoped>
.hint {
  color: #526273;
  line-height: 1.5;
}
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.6rem;
  margin: 0.8rem 0;
}
button {
  padding: 0.6rem 0.9rem;
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
  opacity: 0.55;
  cursor: not-allowed;
}
.summary {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 0.3rem 1rem;
}
.summary dt {
  font-weight: 600;
}
.summary dd {
  margin: 0;
}
.problems {
  padding-left: 1.2rem;
}
.problems li {
  margin: 0.4rem 0;
}
pre {
  overflow-x: auto;
  margin: 0.3rem 0 0;
  padding: 0.5rem;
  background: #f5f7fa;
  font-size: 0.8rem;
  white-space: pre-wrap;
}
.error {
  color: #a22030;
  font-weight: 600;
}
.notice {
  color: #2f6b47;
}
</style>
