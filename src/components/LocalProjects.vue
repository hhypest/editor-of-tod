<script setup lang="ts">
import { templateLabel } from '../domain/registry'
import { onMounted, ref, watch } from 'vue'
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
}>()

const projects = ref<ProjectSummary[]>([])
const historyId = ref<string | null>(null)
const revisions = ref<ProjectRevision[]>([])
const busy = ref(false)
const error = ref('')
const notice = ref('')

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
    error.value = cause instanceof Error ? cause.message : 'Не удалось загрузить черновики.'
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
    error.value = cause instanceof Error ? cause.message : 'Не удалось открыть редакции.'
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
    notice.value = `Редакция № ${revision} скачана отдельным JSON-файлом.`
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'Не удалось скачать редакцию.'
  } finally {
    busy.value = false
  }
}

function dateLabel(value: string): string {
  return new Date(value).toLocaleString('ru-RU')
}
</script>

<template>
  <section aria-labelledby="local-projects-title">
    <h2 id="local-projects-title">Черновики на этом компьютере</h2>
    <p class="hint">
      Сохранённые редакции находятся в локальной SQLite и её резервных копиях. Открытие черновика
      начинает новую историю отмены в текущей вкладке. Любую редакцию можно скачать как JSON.
    </p>
    <button type="button" :disabled="busy || locked" @click="load">Обновить список</button>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p v-if="notice" class="hint" role="status">{{ notice }}</p>
    <p v-if="!projects.length && !busy" class="hint">Пока нет сохранённых черновиков.</p>
    <ul v-else class="project-list">
      <li v-for="project in projects" :key="project.id">
        <div>
          <strong>{{ project.referenceId }} · {{ templateLabel(project.templateCode) }}</strong>
          <small>{{ project.locationText || 'Участок не указан' }}</small>
          <small>Редакция № {{ project.revision }} · {{ dateLabel(project.updatedAt) }}</small>
        </div>
        <div class="actions">
          <button type="button" :disabled="busy || locked" @click="emit('open', project.id)">
            Открыть
          </button>
          <button type="button" :disabled="busy || locked" @click="toggleHistory(project.id)">
            {{ historyId === project.id ? 'Скрыть редакции' : 'Редакции' }}
          </button>
        </div>
        <ul v-if="historyId === project.id" class="revisions">
          <li v-for="revision in revisions" :key="revision.revision">
            <span>№ {{ revision.revision }} · {{ dateLabel(revision.updatedAt) }}</span>
            <div class="actions">
              <button
                type="button"
                :disabled="busy || locked"
                @click="downloadRevision(project.id, revision.revision)"
              >
                Скачать JSON
              </button>
              <button
                v-if="revision.revision !== project.revision"
                type="button"
                :disabled="
                  busy || locked || activeId !== project.id || activeRevision !== project.revision
                "
                @click="emit('restore', project.id, revision.revision, project.revision)"
              >
                Восстановить
              </button>
            </div>
          </li>
        </ul>
      </li>
    </ul>
    <p class="hint">
      Для восстановления прежней редакции сначала откройте последнюю версию этого черновика.
      Восстановление создаст новую редакцию, сохранив прежнюю в истории.
    </p>
  </section>
</template>

<style scoped>
h2 {
  margin: 0 0 0.5rem;
  font-size: 1.4rem;
}
.hint,
small {
  color: #526273;
  font-size: 0.9rem;
  line-height: 1.5;
}
.error {
  color: #a22030;
  font-weight: 600;
}
.project-list,
.revisions {
  list-style: none;
  padding: 0;
}
.project-list > li {
  padding: 0.85rem 0;
  border-bottom: 1px solid #d8e1eb;
}
.project-list small {
  display: block;
  overflow-wrap: anywhere;
}
.actions {
  display: flex;
  align-items: center;
  gap: 0.55rem;
  flex-wrap: wrap;
  margin-top: 0.5rem;
}
.revisions {
  margin: 0.75rem 0 0 1rem;
  border-left: 2px solid #d8e1eb;
}
.revisions li {
  padding: 0.5rem 0 0.5rem 0.85rem;
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
button:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}
</style>
