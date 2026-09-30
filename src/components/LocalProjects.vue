<script setup lang="ts">
import { templateLabel } from '../domain/registry'
import { computed, onMounted, ref, watch } from 'vue'
import type { ProjectRevision, ProjectSummary } from '../domain/local-projects'
import { exportSchemeJson } from '../domain/import'
import { getLocalRevision, listLocalProjects, listLocalRevisions } from '../services/local-projects'

const props = defineProps<{
  activeId: string | null
  activeRevision: number | null
  refreshKey: number
  locked: boolean
}>()
const emit = defineEmits<{
  open: [id: string]
  restore: [id: string, sourceRevision: number, expectedRevision: number]
  create: []
}>()

const projects = ref<ProjectSummary[]>([])
const historyId = ref<string | null>(null)
const revisions = ref<ProjectRevision[]>([])
const busy = ref(false)
const error = ref('')
const notice = ref('')
const query = ref('')

/** Поиск по словам: каждое слово запроса должно встретиться в сведениях проекта. */
const visible = computed(() => {
  const words = query.value
    .toLocaleLowerCase('ru-RU')
    .replace(/ё/g, 'е')
    .split(/\s+/)
    .filter(Boolean)
  if (!words.length) return projects.value
  return projects.value.filter((project) => {
    const text = [
      project.referenceId,
      project.locationText,
      project.crossingLocation,
      project.roadName,
      project.directionLeft,
      project.directionRight,
      project.workDescription,
      templateLabel(project.templateCode),
    ]
      .join(' ')
      .toLocaleLowerCase('ru-RU')
      .replace(/ё/g, 'е')
    return words.every((word) => text.includes(word))
  })
})

function versionsLabel(count: number): string {
  const mod10 = count % 10
  const mod100 = count % 100
  const word =
    mod10 === 1 && mod100 !== 11
      ? 'версия'
      : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)
        ? 'версии'
        : 'версий'
  return `${count} ${word}`
}

async function load(): Promise<void> {
  busy.value = true
  error.value = ''
  try {
    projects.value = await listLocalProjects()
    if (historyId.value) {
      revisions.value = projects.value.some((project) => project.id === historyId.value)
        ? await listLocalRevisions(historyId.value)
        : []
    }
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'Не удалось загрузить список проектов.'
  } finally {
    busy.value = false
  }
}

onMounted(load)
watch(() => props.refreshKey, load)

async function toggleHistory(id: string): Promise<void> {
  if (historyId.value === id) {
    historyId.value = null
    revisions.value = []
    return
  }
  busy.value = true
  error.value = ''
  historyId.value = id
  try {
    revisions.value = await listLocalRevisions(id)
  } catch (cause) {
    revisions.value = []
    error.value = cause instanceof Error ? cause.message : 'Не удалось открыть список версий.'
  } finally {
    busy.value = false
  }
}

async function downloadRevision(id: string, revision: number): Promise<void> {
  busy.value = true
  error.value = ''
  notice.value = ''
  try {
    const { scheme } = await getLocalRevision(id, revision)
    const content = exportSchemeJson(scheme)
    const name = scheme.crossing.referenceId.replace(/[^\p{L}\p{N}_-]/gu, '_').slice(0, 60)
    const objectUrl = URL.createObjectURL(
      new Blob([content], { type: 'application/json;charset=utf-8' }),
    )
    const link = document.createElement('a')
    link.href = objectUrl
    link.download = `scheme_${name || 'crossing'}_local_r${revision}.json`
    document.body.append(link)
    link.click()
    link.remove()
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1_000)
    notice.value = `Версия ${revision} скачана файлом проекта (JSON).`
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'Не удалось скачать версию.'
  } finally {
    busy.value = false
  }
}

function dateLabel(value: string): string {
  return new Date(value).toLocaleString('ru-RU', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}
</script>

<template>
  <section aria-labelledby="local-projects-title">
    <h2 id="local-projects-title">Сохранённые проекты</h2>
    <p class="hint">
      Проекты, сохранённые на этом компьютере. Нажмите «Открыть», чтобы продолжить работу. Каждое
      сохранение хранится отдельной версией — к любой из них можно вернуться.
    </p>
    <div class="toolbar">
      <label class="search"
        >Найти проект
        <input
          v-model="query"
          type="search"
          placeholder="Переезд, участок, дорога или направление"
          autocomplete="off"
      /></label>
      <button type="button" class="quiet" :disabled="busy || locked" @click="load">
        Обновить список
      </button>
    </div>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p v-if="notice" class="hint" role="status">{{ notice }}</p>
    <p v-if="busy && !projects.length" class="hint" role="status">Загружаю список проектов…</p>
    <div v-else-if="!projects.length" class="empty">
      <p>Сохранённых проектов пока нет.</p>
      <p class="hint">
        Начните новый проект по карточке ПУ-66 — после первого сохранения он появится здесь.
      </p>
      <button type="button" class="primary" @click="emit('create')">Новый проект</button>
    </div>
    <p v-else-if="!visible.length" class="hint" role="status">
      Ничего не найдено по запросу «{{ query.trim() }}».
    </p>
    <ul v-else class="project-list">
      <li
        v-for="project in visible"
        :key="project.id"
        :class="{ current: project.id === activeId }"
      >
        <div class="summary">
          <p class="title">
            <strong>Переезд {{ project.referenceId }}</strong>
            <span class="badge">{{ templateLabel(project.templateCode) }}</span>
            <span v-if="project.id === activeId" class="badge open">открыт сейчас</span>
          </p>
          <p v-if="project.crossingLocation || project.roadName" class="line">
            {{ [project.crossingLocation, project.roadName].filter(Boolean).join(' · ') }}
          </p>
          <p class="line">
            Участок: {{ project.locationText || 'не указан' }}
            <template v-if="project.directionLeft || project.directionRight">
              · направления: {{ project.directionLeft || '—' }} /
              {{ project.directionRight || '—' }}
            </template>
          </p>
          <p v-if="project.workDescription" class="line">Работы: {{ project.workDescription }}</p>
          <p class="meta">
            Изменён {{ dateLabel(project.updatedAt) }} · {{ versionsLabel(project.revision) }}
          </p>
        </div>
        <div class="actions">
          <button
            type="button"
            class="primary"
            :disabled="busy || locked"
            @click="emit('open', project.id)"
          >
            {{ project.id === activeId ? 'Открыть заново' : 'Открыть' }}
          </button>
          <button
            type="button"
            :aria-expanded="historyId === project.id"
            :disabled="busy || locked"
            @click="toggleHistory(project.id)"
          >
            {{ historyId === project.id ? 'Скрыть версии' : 'Версии' }}
          </button>
        </div>
        <div v-if="historyId === project.id" class="history">
          <p v-if="activeId !== project.id || activeRevision !== project.revision" class="hint">
            Чтобы вернуться к прежней версии, сначала откройте последнюю версию проекта. Возврат
            создаёт новую версию, прежние остаются в списке.
          </p>
          <ul class="revisions">
            <li v-for="revision in revisions" :key="revision.revision">
              <span
                >Версия {{ revision.revision }} · {{ dateLabel(revision.updatedAt) }}
                <em v-if="revision.revision === project.revision">(последняя)</em></span
              >
              <div class="actions">
                <button
                  type="button"
                  :disabled="busy || locked"
                  @click="downloadRevision(project.id, revision.revision)"
                >
                  Скачать файл
                </button>
                <button
                  v-if="revision.revision !== project.revision"
                  type="button"
                  :disabled="
                    busy || locked || activeId !== project.id || activeRevision !== project.revision
                  "
                  @click="emit('restore', project.id, revision.revision, project.revision)"
                >
                  Вернуться к этой версии
                </button>
              </div>
            </li>
          </ul>
        </div>
      </li>
    </ul>
  </section>
</template>

<style scoped>
h2 {
  margin: 0 0 0.5rem;
  font-size: 1.4rem;
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
.toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 0.6rem 1rem;
  margin: 0.8rem 0;
}
.search {
  flex: 1 1 18rem;
  font-size: 0.9rem;
  font-weight: 600;
}
.search input {
  display: block;
  width: 100%;
  box-sizing: border-box;
  margin-top: 0.3rem;
  padding: 0.55rem;
  border: 1px solid #93a5b8;
  border-radius: 0.35rem;
  font: inherit;
  font-weight: 400;
}
.empty {
  padding: 1rem;
  border: 1px dashed #b7c4d2;
  border-radius: 0.45rem;
}
.empty p {
  margin: 0 0 0.6rem;
}
.project-list,
.revisions {
  list-style: none;
  padding: 0;
  margin: 0;
}
.project-list > li {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 0.4rem 1rem;
  margin-bottom: 0.7rem;
  padding: 0.85rem 1rem;
  border: 1px solid #d8e1eb;
  border-radius: 0.45rem;
}
.project-list > li.current {
  border-color: #185ca5;
  background: #f4f8fd;
}
.summary p {
  margin: 0 0 0.2rem;
  overflow-wrap: anywhere;
}
.title {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.4rem;
}
.badge {
  padding: 0.05rem 0.45rem;
  border-radius: 1rem;
  background: #e6edf5;
  color: #2a3c50;
  font-size: 0.8rem;
}
.badge.open {
  background: #185ca5;
  color: #fff;
}
.line {
  color: #2a3c50;
  font-size: 0.92rem;
}
.meta {
  color: #526273;
  font-size: 0.85rem;
}
.actions {
  display: flex;
  align-items: flex-start;
  gap: 0.55rem;
  flex-wrap: wrap;
}
.history {
  grid-column: 1 / -1;
  border-top: 1px solid #d8e1eb;
  padding-top: 0.5rem;
}
.revisions li {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  padding: 0.4rem 0;
}
button {
  padding: 0.45rem 0.7rem;
  border: 1px solid #185ca5;
  border-radius: 0.4rem;
  background: #fff;
  color: #185ca5;
  cursor: pointer;
  font: inherit;
}
button.primary {
  background: #185ca5;
  color: #fff;
  font-weight: 600;
}
button.quiet {
  border-color: #93a5b8;
  color: #2a3c50;
}
button:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}
@media (max-width: 40rem) {
  .project-list > li {
    grid-template-columns: 1fr;
  }
}
</style>
