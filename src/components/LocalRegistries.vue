<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import type {
  CrossingDraft,
  CrossingRecord,
  NormativeDraft,
  NormativeRecord,
} from '../domain/registry'

const crossings = ref<CrossingRecord[]>([])
const normative = ref<NormativeRecord[]>([])
const error = ref('')
const notice = ref('')
const busy = ref(false)
const crossingRevision = ref(0)
const normativeRevision = ref(0)

function emptyCrossing(): CrossingDraft {
  return {
    referenceId: '',
    railwayLocation: '',
    roadName: '',
    roadOwner: '',
    cardReference: '',
    cardUpdatedAt: '',
    verifiedAt: '',
    notes: '',
  }
}

function emptyNormative(): NormativeDraft {
  return {
    id: '',
    documentCode: '',
    edition: '',
    clause: '',
    description: '',
    application: '',
    sourceUrl: '',
    reviewStatus: 'needs-review',
    checkedAt: '',
    reviewer: '',
  }
}

const crossingForm = reactive<CrossingDraft>(emptyCrossing())
const normativeForm = reactive<NormativeDraft>(emptyNormative())

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, options)
  const body: unknown = await response.json()
  if (!response.ok) {
    const message =
      typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'string'
        ? body.error
        : `Ошибка локального реестра (${response.status}).`
    throw new Error(message)
  }
  return body as T
}

async function load(): Promise<void> {
  busy.value = true
  error.value = ''
  try {
    const [crossingRows, normativeRows] = await Promise.all([
      request<CrossingRecord[]>('/api/crossings'),
      request<NormativeRecord[]>('/api/normative'),
    ])
    crossings.value = crossingRows
    normative.value = normativeRows
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'Локальный реестр недоступен.'
    if (error.value === 'Failed to fetch' || error.value.includes('JSON')) {
      error.value =
        'Не удалось подключиться к локальному реестру. Запустите npm run dev или npm run local.'
    }
  } finally {
    busy.value = false
  }
}

function editCrossing(row: CrossingRecord): void {
  const { revision, updatedAt: _updatedAt, ...draft } = row
  void _updatedAt
  Object.assign(crossingForm, draft)
  crossingRevision.value = revision
  notice.value = ''
}

function editNormative(row: NormativeRecord): void {
  const { revision, updatedAt: _updatedAt, ...draft } = row
  void _updatedAt
  Object.assign(normativeForm, draft)
  normativeRevision.value = revision
  notice.value = ''
}

function clearCrossing(): void {
  Object.assign(crossingForm, emptyCrossing())
  crossingRevision.value = 0
}

function clearNormative(): void {
  Object.assign(normativeForm, emptyNormative())
  normativeRevision.value = 0
}

async function saveCrossing(): Promise<void> {
  busy.value = true
  error.value = ''
  notice.value = ''
  try {
    const saved = await request<CrossingRecord>('/api/crossings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...crossingForm, expectedRevision: crossingRevision.value }),
    })
    clearCrossing()
    await load()
    notice.value = `Карточка ${saved.referenceId} сохранена (редакция ${saved.revision}).`
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'Не удалось сохранить карточку.'
  } finally {
    busy.value = false
  }
}

async function saveNormative(): Promise<void> {
  busy.value = true
  error.value = ''
  notice.value = ''
  try {
    const saved = await request<NormativeRecord>('/api/normative', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...normativeForm, expectedRevision: normativeRevision.value }),
    })
    clearNormative()
    await load()
    notice.value = `Нормативная запись ${saved.id} сохранена (редакция ${saved.revision}).`
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'Не удалось сохранить запись.'
  } finally {
    busy.value = false
  }
}

async function createBackup(): Promise<void> {
  busy.value = true
  error.value = ''
  notice.value = ''
  try {
    const result = await request<{ filename: string }>('/api/backup', { method: 'POST' })
    notice.value = `Резервная копия создана: private-data/backups/${result.filename}`
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'Не удалось создать копию.'
  } finally {
    busy.value = false
  }
}

onMounted(load)
</script>

<template>
  <section class="registry" aria-labelledby="registry-title">
    <h2 id="registry-title">Локальные реестры</h2>
    <p>
      Данные сохраняются в SQLite на этом компьютере. Карточки ПУ-66 не входят в код и не передаются
      в GitHub. Линейное подразделение ОАО «РЖД» отвечает за их актуализацию.
    </p>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p v-if="notice" class="notice" role="status">{{ notice }}</p>
    <button type="button" :disabled="busy" @click="load">Обновить списки</button>
    <button type="button" :disabled="busy" @click="createBackup">
      Создать резервную копию SQLite
    </button>

    <section aria-labelledby="crossings-title">
      <h3 id="crossings-title">Карточки ПУ-66</h3>
      <p class="hint">
        Реестр заполняется вручную по разрешённым карточкам. Связь с импортированным проектом пока
        не автоматическая.
      </p>
      <p v-if="crossings.length === 0" class="hint">Карточек пока нет.</p>
      <ul v-else class="record-list">
        <li v-for="row in crossings" :key="row.referenceId">
          <strong>{{ row.referenceId }}</strong> — {{ row.railwayLocation || 'место не указано' }} ·
          редакция {{ row.revision }} · сверено: {{ row.verifiedAt || 'не указано' }}
          <button type="button" :disabled="busy" @click="editCrossing(row)">Изменить</button>
        </li>
      </ul>
      <form @submit.prevent="saveCrossing">
        <h4>{{ crossingRevision ? 'Изменить карточку' : 'Новая карточка' }}</h4>
        <div class="fields">
          <label
            >Ключ из проекта / ПУ-66
            <input
              v-model="crossingForm.referenceId"
              required
              maxlength="120"
              :readonly="crossingRevision > 0"
          /></label>
          <label
            >Место на железной дороге <input v-model="crossingForm.railwayLocation" maxlength="240"
          /></label>
          <label
            >Автомобильная дорога <input v-model="crossingForm.roadName" maxlength="240"
          /></label>
          <label>Владелец дороги <input v-model="crossingForm.roadOwner" maxlength="240" /></label>
          <label
            >Реквизиты карточки ПУ-66 <input v-model="crossingForm.cardReference" maxlength="240"
          /></label>
          <label>Дата карточки <input v-model="crossingForm.cardUpdatedAt" type="date" /></label>
          <label>Дата сверки <input v-model="crossingForm.verifiedAt" type="date" /></label>
          <label class="wide"
            >Примечания <textarea v-model="crossingForm.notes" maxlength="5000" rows="3" />
          </label>
        </div>
        <button type="submit" :disabled="busy">Сохранить карточку</button>
        <button type="button" :disabled="busy" @click="clearCrossing">Новая запись</button>
      </form>
    </section>

    <section aria-labelledby="normative-title">
      <h3 id="normative-title">Нормативные источники и пункты</h3>
      <p class="hint">
        При первом запуске внесены только ссылки и краткие описания ОДМ и ГОСТ. Полные тексты и
        изображения не включены. Статус «проверено» задаётся после предметной сверки ответственным.
      </p>
      <ul class="record-list">
        <li v-for="row in normative" :key="row.id">
          <strong>{{ row.documentCode }}</strong> — {{ row.clause }} ·
          {{ row.reviewStatus === 'checked' ? 'проверено' : 'требует сверки' }} · редакция
          {{ row.revision }}
          <button type="button" :disabled="busy" @click="editNormative(row)">Изменить</button>
        </li>
      </ul>
      <form @submit.prevent="saveNormative">
        <h4>
          {{ normativeRevision ? 'Изменить нормативную запись' : 'Новая нормативная запись' }}
        </h4>
        <div class="fields">
          <label
            >Код записи (латиница, цифры, `._-`)
            <input
              v-model="normativeForm.id"
              required
              pattern="[a-z0-9][a-z0-9._-]{1,79}"
              :readonly="normativeRevision > 0"
          /></label>
          <label
            >Документ <input v-model="normativeForm.documentCode" required maxlength="240"
          /></label>
          <label>Редакция <input v-model="normativeForm.edition" required maxlength="240" /></label>
          <label
            >Пункт или рисунок <input v-model="normativeForm.clause" required maxlength="240"
          /></label>
          <label class="wide"
            >Краткое содержание
            <textarea v-model="normativeForm.description" required maxlength="2000" rows="2" />
          </label>
          <label class="wide"
            >Применение в проекте и оговорки
            <textarea v-model="normativeForm.application" maxlength="2000" rows="2" />
          </label>
          <label class="wide"
            >Ссылка на источник
            <input v-model="normativeForm.sourceUrl" type="url" maxlength="1000"
          /></label>
          <label
            >Статус
            <select v-model="normativeForm.reviewStatus">
              <option value="needs-review">Требует сверки</option>
              <option value="checked">Проверено</option>
            </select></label
          >
          <label>Дата проверки <input v-model="normativeForm.checkedAt" type="date" /></label>
          <label
            >Ответственный за сверку <input v-model="normativeForm.reviewer" maxlength="240"
          /></label>
        </div>
        <button type="submit" :disabled="busy">Сохранить нормативную запись</button>
        <button type="button" :disabled="busy" @click="clearNormative">Новая запись</button>
      </form>
    </section>
  </section>
</template>

<style scoped>
.registry {
  margin: 1rem 0;
  padding: 2rem;
  background: #fff;
  border: 1px solid #d8e1eb;
  border-radius: 0.8rem;
}
h2 {
  margin-top: 0;
}
section section {
  margin-top: 2rem;
  border-top: 1px solid #d8e1eb;
}
.hint {
  color: #526273;
  line-height: 1.5;
}
.error {
  color: #a22030;
  font-weight: 600;
}
.notice {
  color: #165d37;
  font-weight: 600;
}
.record-list {
  padding-left: 1.2rem;
}
.record-list li {
  margin-bottom: 0.7rem;
}
.fields {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(15rem, 1fr));
  gap: 1rem;
  margin-bottom: 1rem;
}
.fields label {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  font-weight: 600;
}
.wide {
  grid-column: 1 / -1;
}
input,
select,
textarea {
  padding: 0.55rem;
  border: 1px solid #93a5b8;
  border-radius: 0.35rem;
  font: inherit;
  width: 100%;
  box-sizing: border-box;
}
button {
  margin: 0.3rem 0.5rem 0.3rem 0;
  padding: 0.55rem 0.8rem;
  background: #fff;
  border: 1px solid #185ca5;
  border-radius: 0.35rem;
  color: #185ca5;
  cursor: pointer;
  font: inherit;
}
button:disabled {
  opacity: 0.5;
  cursor: wait;
}
button:focus-visible {
  outline: 2px solid #185ca5;
  outline-offset: 2px;
}
</style>
