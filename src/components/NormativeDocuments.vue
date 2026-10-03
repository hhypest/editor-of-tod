<script setup lang="ts">
import { timed } from '../services/diagnostics'
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import {
  actualityCheckDue,
  catalogEditionStatus,
  documentKinds,
  documentLabel,
  documentStatuses,
  normalizeDocumentCode,
  suggestFromFilename,
  type DocumentMeta,
  type DocumentRecord,
  type DocumentStatus,
} from '../domain/normative-documents'
import type { DocumentCandidate, DocumentIdentification } from '../domain/document-identification'
import { localCalendarDate } from '../domain/pu66-review'
import {
  applyDocument,
  deleteDocument,
  documentPdfUrl,
  listDocuments,
  identifyDocument,
  MAX_DOCUMENT_BYTES,
  previewDocument,
  updateDocument,
  type DocumentPreview,
} from '../services/local-documents'
import { getSignCatalog, type SignCatalog } from '../services/local-signs'

const props = defineProps<{ locked?: boolean }>()
const emit = defineEmits<{ changed: [] }>()

const today = localCalendarDate(new Date())
const documents = ref<DocumentRecord[]>([])
const catalog = ref<SignCatalog | null>(null)
const busy = ref(false)
const error = ref('')
const notice = ref('')

function emptyMeta(): DocumentMeta {
  return {
    code: '',
    edition: '',
    title: '',
    kind: 'other',
    effectiveFrom: '',
    amendsId: null,
    note: '',
    actualCheckedAt: today,
  }
}
const file = ref<File | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)
const form = reactive<DocumentMeta>(emptyMeta())
const preview = ref<DocumentPreview | null>(null)
const identification = ref<DocumentIdentification | null>(null)
const identifying = ref(false)
const identificationError = ref('')
const filenameSuggestion = computed(() => suggestFromFilename(file.value?.name ?? ''))
const identificationChoice = ref<'candidate' | 'manual' | null>(null)
const selectedType = ref<DocumentCandidate['documentType'] | null>(null)
const manualFields = new Set<keyof DocumentMeta>()
let identificationRequest = 0
onBeforeUnmount(() => {
  identificationRequest++
})
watch(form, () => {
  preview.value = null
})
const editingId = ref<number | null>(null)
const editForm = reactive<DocumentMeta>(emptyMeta())

const statuses = computed(() => documentStatuses(documents.value, today))
const byId = computed(() => new Map(documents.value.map((document) => [document.id, document])))
const baseDocuments = computed(() => documents.value.filter((item) => item.amendsId === null))
/** Документы по кодам: сверху группа знаков, внутри — от новой редакции к старой. */
const groups = computed(() => {
  const map = new Map<string, DocumentRecord[]>()
  for (const document of baseDocuments.value) {
    const key = normalizeDocumentCode(document.code)
    map.set(key, [...(map.get(key) ?? []), document])
  }
  return [...map.entries()]
    .map(([code, items]) => ({
      code,
      items: [...items].reverse(),
      amendments: documents.value.filter((item) => items.some((base) => base.id === item.amendsId)),
    }))
    .sort(
      (a, b) =>
        Number(b.items[0]?.kind === 'signs') - Number(a.items[0]?.kind === 'signs') ||
        a.code.localeCompare(b.code),
    )
})
const signsStatus = computed(() => catalogEditionStatus(catalog.value, documents.value, today))
const checksDue = computed(() =>
  baseDocuments.value.filter(
    (document) =>
      statuses.value.get(document.id)?.kind === 'current' && actualityCheckDue(document, today),
  ),
)

function statusText(document: DocumentRecord): string {
  const status: DocumentStatus | undefined = statuses.value.get(document.id)
  if (!status) return ''
  if (status.kind === 'current') return 'действует'
  if (status.kind === 'superseded') {
    const by = byId.value.get(status.by)
    return `заменён${by ? ` редакцией ${by.edition}` : ''}`
  }
  if (status.kind === 'future') return `вводится с ${status.from}`
  if (status.kind === 'amendment')
    return status.inForce ? 'изменение действует' : 'изменение ещё не введено'
  return 'дата введения не указана'
}

async function load(): Promise<void> {
  busy.value = true
  error.value = ''
  try {
    const [list, current] = await Promise.all([listDocuments(), getSignCatalog()])
    documents.value = list
    catalog.value = current
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'Библиотека документов недоступна.'
  } finally {
    busy.value = false
  }
}
onMounted(load)

async function chooseFile(event: Event): Promise<void> {
  const request = ++identificationRequest
  const chosen = (event.target as HTMLInputElement).files?.[0] ?? null
  file.value = chosen
  preview.value = null
  notice.value = ''
  error.value = ''
  identification.value = null
  identificationError.value = ''
  identificationChoice.value = null
  selectedType.value = null
  identifying.value = false
  const empty = emptyMeta()
  for (const key of ['code', 'edition', 'title', 'kind', 'amendsId'] as const) {
    if (!manualFields.has(key)) Object.assign(form, { [key]: empty[key] })
  }
  if (!chosen) return
  if (!/\.pdf$/i.test(chosen.name)) {
    error.value = 'Выберите файл PDF.'
    return
  }
  if (chosen.size > MAX_DOCUMENT_BYTES) {
    error.value = 'PDF больше 40 МБ.'
    return
  }
  identifying.value = true
  try {
    const result = await identifyDocument(chosen)
    if (request === identificationRequest) identification.value = result
  } catch (cause) {
    if (request === identificationRequest)
      identificationError.value =
        cause instanceof Error ? cause.message : 'Не удалось определить документ.'
  } finally {
    if (request === identificationRequest) identifying.value = false
  }
}

function metaEdited(key: keyof DocumentMeta): void {
  manualFields.add(key)
  preview.value = null
}

function useCandidate(candidate: DocumentCandidate): void {
  Object.assign(form, {
    code: candidate.code,
    edition: candidate.edition,
    title: candidate.title,
    kind: candidate.kind,
  })
  const parents = baseDocuments.value.filter(
    (item) =>
      normalizeDocumentCode(item.code) === candidate.code &&
      item.edition.trim() === candidate.baseEdition,
  )
  form.amendsId = candidate.documentType !== 'base' && parents.length === 1 ? parents[0]!.id : null
  for (const key of ['code', 'edition', 'title', 'kind', 'amendsId'] as const)
    manualFields.delete(key)
  selectedType.value = candidate.documentType
  identificationChoice.value = 'candidate'
  error.value = ''
}

function useManualMeta(): void {
  identificationChoice.value = 'manual'
  selectedType.value = null
  error.value = ''
}

function useFilenameMeta(): void {
  Object.assign(form, filenameSuggestion.value)
  for (const key of ['code', 'edition', 'kind'] as const) manualFields.delete(key)
  useManualMeta()
}

function resetForm(): void {
  identificationRequest++
  manualFields.clear()
  Object.assign(form, emptyMeta())
  file.value = null
  preview.value = null
  identification.value = null
  identificationError.value = ''
  identificationChoice.value = null
  selectedType.value = null
  identifying.value = false
  if (fileInput.value) fileInput.value.value = ''
}

async function check(): Promise<void> {
  if (busy.value || props.locked || !file.value || identifying.value || !identificationChoice.value)
    return
  if (selectedType.value && selectedType.value !== 'base' && form.amendsId === null) {
    error.value =
      'Выберите основной документ в поле «Изменение к документу». Если его нет, сначала добавьте основной PDF.'
    return
  }
  busy.value = true
  error.value = ''
  notice.value = ''
  try {
    preview.value = await timed('Проверка документа', () =>
      previewDocument(file.value!, { ...form }),
    )
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'Не удалось проверить PDF.'
  } finally {
    busy.value = false
  }
}

const effectText = computed(() => {
  if (!preview.value) return ''
  const { status, replaces } = preview.value.effect
  if (status.kind === 'current')
    return replaces.length
      ? `Станет действующей редакцией вместо ${replaces.map((item) => `${normalizeDocumentCode(item.code)}-${item.edition}`).join(', ')}; прежняя останется в библиотеке с отметкой «заменён».`
      : 'Станет действующей редакцией этого документа.'
  if (status.kind === 'future')
    return `Будет действовать с ${status.from}; до этой даты действует прежняя редакция.`
  if (status.kind === 'superseded')
    return 'Более новая редакция уже есть: документ будет отмечен как заменённый.'
  if (status.kind === 'amendment')
    return status.inForce
      ? 'Изменение к стандарту, уже действует.'
      : 'Изменение к стандарту, ещё не введено.'
  return 'Дата введения и год редакции не указаны: статус определить нельзя.'
})

async function add(): Promise<void> {
  if (!file.value || !preview.value) return
  busy.value = true
  error.value = ''
  try {
    const result = await timed('Добавление документа', () =>
      applyDocument(file.value!, { ...form }, preview.value!.fingerprint),
    )
    notice.value = `${documentLabel(result.document)} добавлен в библиотеку. Копия SQLite: ${result.backup}.`
    resetForm()
    await load()
    emit('changed')
  } catch (cause) {
    preview.value = null
    error.value = `${cause instanceof Error ? cause.message : 'Не удалось добавить документ.'} Проверьте файл ещё раз.`
  } finally {
    busy.value = false
  }
}

function startEdit(document: DocumentRecord): void {
  editingId.value = document.id
  const { code, edition, title, kind, effectiveFrom, amendsId, note, actualCheckedAt } = document
  Object.assign(editForm, {
    code,
    edition,
    title,
    kind,
    effectiveFrom,
    amendsId,
    note,
    actualCheckedAt,
  })
}

async function saveEdit(): Promise<void> {
  if (editingId.value === null) return
  busy.value = true
  error.value = ''
  try {
    const updated = await updateDocument(editingId.value, { ...editForm })
    notice.value = `Сведения ${documentLabel(updated)} сохранены.`
    editingId.value = null
    await load()
    emit('changed')
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'Не удалось сохранить сведения.'
  } finally {
    busy.value = false
  }
}

async function markChecked(document: DocumentRecord): Promise<void> {
  busy.value = true
  error.value = ''
  try {
    const { code, edition, title, kind, effectiveFrom, amendsId, note } = document
    await updateDocument(document.id, {
      code,
      edition,
      title,
      kind,
      effectiveFrom,
      amendsId,
      note,
      actualCheckedAt: today,
    })
    notice.value = `Актуальность ${documentLabel(document)} подтверждена на ${today}.`
    await load()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'Не удалось записать проверку.'
  } finally {
    busy.value = false
  }
}

async function remove(document: DocumentRecord): Promise<void> {
  if (!window.confirm(`Удалить ${documentLabel(document)} из локальной библиотеки?`)) return
  busy.value = true
  error.value = ''
  try {
    await deleteDocument(document.id)
    notice.value = `${documentLabel(document)} удалён из библиотеки.`
    await load()
    emit('changed')
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'Не удалось удалить документ.'
  } finally {
    busy.value = false
  }
}

function megabytes(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1).replace('.', ',')
}
</script>

<template>
  <section class="library" aria-labelledby="documents-title">
    <h2 id="documents-title">Нормативные документы и редакции</h2>
    <p class="hint">
      Прикрепите PDF стандартов и методических документов, по которым составляются схемы (ГОСТ Р
      52290 — знаки, ГОСТ Р 52289 — правила применения, ОДМ 218.6.019 — схемы Б.33/Б.34), и
      изменения к ним. При выходе новой редакции добавьте её с датой введения: прежняя редакция
      останется в библиотеке с отметкой «заменён», а приложение подскажет, если каталог знаков или
      проекты используют устаревшую редакцию. Файлы хранятся только в локальной базе на этом
      компьютере. Актуальность редакций приложение само не проверяет — подтверждайте её раз в год.
    </p>

    <div v-if="signsStatus.kind === 'outdated'" class="warning" role="status">
      Каталог знаков загружен по редакции {{ signsStatus.catalogEdition }}, а действует
      {{ documentLabel(signsStatus.document) }}. Извлеките знаки из PDF этой редакции в «Импорт
      Excel и знаков» (блок «Знаки из PDF стандарта»).
    </div>
    <div v-else-if="signsStatus.kind === 'current'" class="ok" role="status">
      Каталог знаков соответствует действующей редакции {{ documentLabel(signsStatus.document) }}.
    </div>
    <div v-if="checksDue.length" class="warning" role="status">
      Подтвердите актуальность действующих редакций (проверка раз в год):
      {{ checksDue.map(documentLabel).join(', ') }}.
    </div>

    <p v-if="busy" role="status">Работа с локальной библиотекой…</p>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p v-if="notice" class="notice" role="status">{{ notice }}</p>

    <p v-if="!groups.length && !busy">Документов пока нет.</p>
    <article v-for="group in groups" :key="group.code" class="group">
      <h3>{{ group.code }}</h3>
      <ul>
        <li
          v-for="document in [...group.items, ...group.amendments]"
          :key="document.id"
          :class="`status-${statuses.get(document.id)?.kind}`"
        >
          <div class="row">
            <strong>
              {{ document.amendsId === null ? `Редакция ${document.edition}` : document.edition }}
            </strong>
            <span class="badge">{{ statusText(document) }}</span>
            <span v-if="document.title">{{ document.title }}</span>
          </div>
          <div class="meta">
            {{ documentKinds[document.kind] }}
            · введён: {{ document.effectiveFrom || 'дата не указана' }}
            <template v-if="document.amendsId !== null">
              · изменение к редакции {{ byId.get(document.amendsId)?.edition }}
            </template>
            · {{ document.filename }}, {{ megabytes(document.sizeBytes) }} МБ · актуальность
            проверена: {{ document.actualCheckedAt || 'нет' }}
            <span
              v-if="
                statuses.get(document.id)?.kind === 'current' && actualityCheckDue(document, today)
              "
              class="due"
              >— пора проверить</span
            >
          </div>
          <p v-if="document.note" class="meta">{{ document.note }}</p>
          <div class="actions">
            <a :href="documentPdfUrl(document.id)" target="_blank" rel="noopener">Открыть PDF</a>
            <button type="button" :disabled="busy || locked" @click="markChecked(document)">
              Актуальность подтверждена сегодня
            </button>
            <button type="button" :disabled="busy || locked" @click="startEdit(document)">
              Изменить сведения
            </button>
            <button type="button" :disabled="busy || locked" @click="remove(document)">
              Удалить
            </button>
          </div>
          <form v-if="editingId === document.id" class="fields" @submit.prevent="saveEdit">
            <label>Обозначение <input v-model="editForm.code" required maxlength="120" /></label>
            <label>Редакция <input v-model="editForm.edition" required maxlength="60" /></label>
            <label class="wide">Название <input v-model="editForm.title" maxlength="500" /></label>
            <label
              >Назначение
              <select v-model="editForm.kind">
                <option v-for="(label, kind) in documentKinds" :key="kind" :value="kind">
                  {{ label }}
                </option>
              </select>
            </label>
            <label>Дата введения <input v-model="editForm.effectiveFrom" type="date" /></label>
            <label
              >Изменение к
              <select v-model="editForm.amendsId">
                <option :value="null">— основной документ —</option>
                <option
                  v-for="base in baseDocuments.filter((item) => item.id !== document.id)"
                  :key="base.id"
                  :value="base.id"
                >
                  {{ documentLabel(base) }}
                </option>
              </select>
            </label>
            <label
              >Актуальность проверена
              <input v-model="editForm.actualCheckedAt" type="date" />
            </label>
            <label class="wide">Примечание <textarea v-model="editForm.note" rows="2" /></label>
            <div class="wide">
              <button type="submit" class="primary" :disabled="busy">Сохранить</button>
              <button type="button" :disabled="busy" @click="editingId = null">Отмена</button>
            </div>
          </form>
        </li>
      </ul>
    </article>

    <h3>Добавить документ или новую редакцию</h3>
    <p v-if="locked" role="status">Сначала примените или отмените правки открытого проекта.</p>
    <form class="fields" @submit.prevent="check">
      <label class="wide">
        PDF (до {{ MAX_DOCUMENT_BYTES / 1024 / 1024 }} МБ)
        <input
          ref="fileInput"
          type="file"
          accept=".pdf,application/pdf"
          :disabled="busy || locked"
          @change="chooseFile"
        />
      </label>
      <div class="wide identification" aria-live="polite">
        <p v-if="identifying" role="status">Определение документа по тексту первых страниц PDF…</p>
        <p v-if="identificationError" class="warning">{{ identificationError }}</p>
        <template v-if="identification">
          <p v-if="identification.status === 'ambiguous'" class="warning">
            Найдено несколько обозначений. Выберите нужное или заполните сведения вручную.
          </p>
          <p v-if="identification.filenameConflict" class="warning">
            Обозначение в имени файла не совпадает с текстом PDF. Сверьте сведения перед
            добавлением.
          </p>
          <p v-if="identification.status === 'no-text'" class="warning">
            На первых {{ identification.pagesRead }} страницах нет текстового слоя. Для скана
            заполните сведения вручную.
          </p>
          <p v-else-if="identification.status === 'unrecognized'" class="warning">
            На первых {{ identification.pagesRead }} страницах заголовок документа не определён.
            Заполните сведения вручную.
          </p>
          <article
            v-for="candidate in identification.candidates"
            :key="`${candidate.code}/${candidate.edition}`"
            class="candidate"
          >
            <strong>{{ candidate.code }} — {{ candidate.edition }}</strong>
            <p v-if="candidate.title">{{ candidate.title }}</p>
            <p class="meta">
              {{
                candidate.documentType === 'base'
                  ? 'Основной документ'
                  : candidate.documentType === 'amendment'
                    ? `Изменение к редакции ${candidate.baseEdition}`
                    : `Поправка к редакции ${candidate.baseEdition}`
              }}
              · стр. PDF {{ candidate.page }} · {{ documentKinds[candidate.kind] }}
            </p>
            <button type="button" :disabled="busy || locked" @click="useCandidate(candidate)">
              Использовать сведения
            </button>
          </article>
        </template>
        <template v-if="file && !identifying">
          <p v-if="filenameSuggestion.code" class="meta">
            По имени файла: {{ filenameSuggestion.code }} {{ filenameSuggestion.edition }}. Имя
            файла не подтверждает содержание или актуальность редакции.
          </p>
          <button
            v-if="filenameSuggestion.code"
            type="button"
            :disabled="busy || locked"
            @click="useFilenameMeta"
          >
            Использовать сведения из имени файла
          </button>
          <button type="button" :disabled="busy || locked" @click="useManualMeta">
            Заполнить вручную
          </button>
          <p v-if="identificationChoice === 'candidate'" class="hint">
            Сведения подставлены. Проверьте поля, дату введения и связь изменения с основным
            документом.
          </p>
          <p v-else-if="identificationChoice === 'manual'" class="hint">
            Используются сведения, введённые вручную. Сверьте их по PDF.
          </p>
          <p v-else class="hint">
            Примите найденные сведения или выберите ручное заполнение. Введённые вручную поля
            сохранены.
          </p>
        </template>
      </div>
      <label
        >Обозначение
        <input
          v-model="form.code"
          :disabled="busy || locked"
          required
          maxlength="120"
          placeholder="ГОСТ Р 52290"
          @input="metaEdited('code')"
      /></label>
      <label
        >Редакция
        <input
          v-model="form.edition"
          :disabled="busy || locked"
          required
          maxlength="60"
          placeholder="2024 или «Изменение № 1»"
          @input="metaEdited('edition')"
      /></label>
      <label class="wide"
        >Название
        <input
          v-model="form.title"
          :disabled="busy || locked"
          maxlength="500"
          placeholder="Технические средства организации дорожного движения. Знаки дорожные…"
          @input="metaEdited('title')"
      /></label>
      <label
        >Назначение
        <select v-model="form.kind" :disabled="busy || locked" @change="metaEdited('kind')">
          <option v-for="(label, kind) in documentKinds" :key="kind" :value="kind">
            {{ label }}
          </option>
        </select>
      </label>
      <label
        >Дата введения в действие
        <input
          v-model="form.effectiveFrom"
          type="date"
          :disabled="busy || locked"
          @input="preview = null"
        />
      </label>
      <label
        >Изменение к документу
        <select v-model="form.amendsId" :disabled="busy || locked" @change="metaEdited('amendsId')">
          <option :value="null">— основной документ (новая редакция) —</option>
          <option v-for="base in baseDocuments" :key="base.id" :value="base.id">
            {{ documentLabel(base) }}
          </option>
        </select>
      </label>
      <label
        >Актуальность проверена
        <input v-model="form.actualCheckedAt" type="date" :disabled="busy || locked" />
      </label>
      <label class="wide"
        >Примечание
        <textarea
          v-model="form.note"
          :disabled="busy || locked"
          rows="2"
          placeholder="Откуда получен документ, приказ о введении и т. п."
        />
      </label>
      <div class="wide">
        <button
          type="submit"
          :disabled="busy || locked || !file || identifying || !identificationChoice"
        >
          Проверить документ
        </button>
      </div>
    </form>
    <div v-if="preview" class="preview" role="status">
      <p>
        {{ preview.filename }}, {{ megabytes(preview.sizeBytes) }} МБ, SHA-256
        <code>{{ preview.sha256 }}</code>
      </p>
      <p v-if="preview.duplicate" class="error">
        Этот PDF уже есть в библиотеке: {{ documentLabel(preview.duplicate) }}.
      </p>
      <p v-else>{{ effectText }}</p>
      <button
        type="button"
        class="primary"
        :disabled="busy || locked || Boolean(preview.duplicate)"
        @click="add"
      >
        Добавить в библиотеку и создать копию SQLite
      </button>
    </div>
  </section>
</template>

<style scoped>
.library {
  margin: 1rem 0;
  padding: 2rem;
  background: #fff;
  border: 1px solid #d8e1eb;
  border-radius: 0.8rem;
}
h2 {
  margin-top: 0;
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
.warning,
.ok {
  margin: 0.8rem 0;
  padding: 0.6rem 0.9rem;
  border-left: 4px solid #b8860b;
  background: #fbf5e3;
}
.ok {
  border-left-color: #2f7d5b;
  background: #eef6f1;
}
.group {
  margin: 1.2rem 0;
  padding-top: 0.6rem;
  border-top: 1px solid #d8e1eb;
}
.group ul {
  padding: 0;
  list-style: none;
}
.group li {
  margin: 0.6rem 0;
  padding: 0.6rem 0.8rem;
  border: 1px solid #d8e1eb;
  border-radius: 0.45rem;
}
.group li.status-superseded {
  opacity: 0.75;
}
.row {
  display: flex;
  flex-wrap: wrap;
  gap: 0.6rem;
  align-items: baseline;
}
.badge {
  padding: 0.05rem 0.5rem;
  border-radius: 1rem;
  background: #e4ebf2;
  font-size: 0.85rem;
}
.status-current .badge {
  background: #d9efe2;
  color: #165d37;
}
.status-future .badge {
  background: #fbf0d0;
}
.meta {
  margin: 0.3rem 0;
  color: #526273;
  font-size: 0.9rem;
}
.due {
  color: #8a3b12;
  font-weight: 600;
}
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  align-items: center;
}
.fields {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(15rem, 1fr));
  gap: 0.8rem 1rem;
  margin: 0.8rem 0;
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
  padding: 0.5rem;
  border: 1px solid #93a5b8;
  border-radius: 0.35rem;
  font: inherit;
}
button {
  padding: 0.5rem 0.8rem;
  border: 1px solid #185ca5;
  border-radius: 0.4rem;
  background: #fff;
  color: #185ca5;
  font: inherit;
  cursor: pointer;
}
button.primary {
  background: #185ca5;
  color: #fff;
}
button:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
.preview code {
  overflow-wrap: anywhere;
}
.candidate {
  margin: 0.7rem 0;
  padding: 0.8rem;
  border: 1px solid #93a5b8;
  border-radius: 0.4rem;
}
</style>
