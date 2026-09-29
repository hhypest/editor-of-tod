<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { documentLabel, documentStatuses, type DocumentRecord } from '../domain/normative-documents'
import { localCalendarDate } from '../domain/pu66-review'
import { drawableWithoutImage } from '../domain/sheet-drawing'
import {
  applyPdfSigns,
  pdfSignImageUrl,
  previewPdfSigns,
  type PdfSignImage,
  type PdfSignOverrides,
  type PdfSignPlan,
} from '../services/local-signs'

const props = defineProps<{
  documents: readonly DocumentRecord[]
  locked: boolean
}>()
const emit = defineEmits<{ applied: [] }>()

const today = localCalendarDate(new Date())
/** Документы с изображениями знаков: действующая редакция первой. */
const candidates = computed(() => {
  const statuses = documentStatuses(props.documents, today)
  return props.documents
    .filter((document) => document.amendsId === null && document.kind === 'signs')
    .map((document) => ({ document, status: statuses.get(document.id)?.kind ?? 'undated' }))
    .sort((a, b) => Number(b.status === 'current') - Number(a.status === 'current'))
})
const documentId = ref<number | ''>('')
watch(
  candidates,
  (list) => {
    if (documentId.value !== '' && list.some((item) => item.document.id === documentId.value))
      return
    documentId.value = list[0]?.document.id ?? ''
  },
  { immediate: true },
)

const plan = ref<PdfSignPlan | null>(null)
/** Исправления, по которым построен текущий план. */
const planned = ref<PdfSignOverrides>({})
/** Исправления в полях: номер знака или null — не включать изображение. */
const edits = ref<PdfSignOverrides>({})
const busy = ref(false)
const error = ref('')
const notice = ref('')
const filter = ref<'attention' | 'all'>('attention')
const search = ref('')

const stale = computed(
  () => JSON.stringify(sorted(edits.value)) !== JSON.stringify(sorted(planned.value)),
)

function sorted(overrides: PdfSignOverrides): Array<[string, string | null]> {
  return Object.entries(overrides).sort(([a], [b]) => a.localeCompare(b))
}

function reset(): void {
  plan.value = null
  planned.value = {}
  edits.value = {}
  error.value = ''
}

watch(documentId, () => {
  reset()
  notice.value = ''
})

async function preview(): Promise<void> {
  if (documentId.value === '' || props.locked) return
  busy.value = true
  error.value = ''
  notice.value = ''
  const overrides = { ...edits.value }
  try {
    plan.value = await previewPdfSigns(documentId.value, overrides)
    planned.value = overrides
    if (!plan.value.images.some(needsAttention)) filter.value = 'all'
  } catch (cause) {
    plan.value = null
    error.value = cause instanceof Error ? cause.message : 'Не удалось извлечь знаки из PDF.'
  } finally {
    busy.value = false
  }
}

async function apply(): Promise<void> {
  if (!plan.value || documentId.value === '' || props.locked || stale.value) return
  busy.value = true
  error.value = ''
  try {
    const result = await applyPdfSigns(documentId.value, planned.value, plan.value.fingerprint)
    reset()
    emit('applied')
    notice.value = `Каталог знаков записан по ${result.source.documentCode}-${result.source.edition}: новых ${result.added}, изменено изображений ${result.changedCodes.length}, сменилась только редакция источника у ${result.relabelled}, исключено из текущего набора ${result.retired}. ${result.backup ? `Копия SQLite: private-data/backups/${result.backup}.` : 'Изменений нет.'}`
  } catch (cause) {
    plan.value = null
    error.value = `${cause instanceof Error ? cause.message : 'Не удалось записать каталог.'} Повторите просмотр перед записью.`
  } finally {
    busy.value = false
  }
}

function needsAttention(image: PdfSignImage): boolean {
  return image.reason !== 'detected' || /_v\d+$/.test(image.code ?? '') || image.example
}

const shown = computed(() => {
  if (!plan.value) return []
  const query = search.value.trim()
  return plan.value.images.filter(
    (image) =>
      (filter.value === 'all' || needsAttention(image)) &&
      (!query ||
        (image.code ?? '').startsWith(query) ||
        (image.detected ?? '').startsWith(query) ||
        String(image.page) === query),
  )
})
const unresolved = computed(
  () => plan.value?.images.filter((image) => image.reason === 'no-label') ?? [],
)

function numberValue(image: PdfSignImage): string {
  const edit = edits.value[image.key]
  return edit === undefined ? (image.detected ?? '') : (edit ?? image.detected ?? '')
}

function included(image: PdfSignImage): boolean {
  return edits.value[image.key] !== null
}

function setNumber(image: PdfSignImage, event: Event): void {
  const value = (event.target as HTMLInputElement).value.trim()
  const next = { ...edits.value }
  // Пустое поле возвращает найденный номер; исключение — отдельной отметкой.
  if (!value || value === image.detected) delete next[image.key]
  else next[image.key] = value
  edits.value = next
}

function setIncluded(image: PdfSignImage, event: Event): void {
  const next = { ...edits.value }
  if ((event.target as HTMLInputElement).checked) delete next[image.key]
  else next[image.key] = null
  edits.value = next
}

/** Изображение из PDF для кода каталога: сам знак или его жёлтый вариант. */
function newImage(code: string): string | null {
  if (!plan.value || documentId.value === '') return null
  const yellow = code.endsWith('_ж')
  const base = yellow ? code.slice(0, -2) : code
  const image = plan.value.images.find((item) => item.code === base)
  return image ? pdfSignImageUrl(documentId.value, image.key, yellow) : null
}

const retiredDrawn = computed(() => plan.value?.retiredCodes.filter(drawableWithoutImage) ?? [])
const retiredOther = computed(
  () => plan.value?.retiredCodes.filter((code) => !drawableWithoutImage(code)) ?? [],
)
const changedShown = computed(() => plan.value?.changedCodes.slice(0, 120) ?? [])

function statusLabel(status: string): string {
  return status === 'current'
    ? ' (действует)'
    : status === 'superseded'
      ? ' (заменён)'
      : status === 'future'
        ? ' (ещё не введён)'
        : ''
}
</script>

<template>
  <div class="pdf-signs">
    <h4 id="pdf-sign-import">Знаки из PDF стандарта</h4>
    <p>
      Программа вынимает изображения знаков из таблиц А.1–А.8 приложения А ГОСТ Р 52290 и определяет
      номер каждого по подписи под изображением. Знаки, которые по перечню стандарта допускается
      выполнять с жёлтым фоном, получают вариант «_ж». Перед записью проверьте номера; каталог
      заменяется целиком, прежние изображения остаются в истории SQLite.
    </p>
    <p v-if="!candidates.length" class="hint">
      Прикрепите PDF ГОСТ Р 52290 в «Реестры» → «Нормативные документы» с назначением «Изображения
      знаков».
    </p>
    <template v-else>
      <label
        >Документ
        <select v-model="documentId" :disabled="busy || locked">
          <option v-for="item in candidates" :key="item.document.id" :value="item.document.id">
            {{ documentLabel(item.document) }}{{ statusLabel(item.status) }}
          </option>
        </select>
      </label>
      <button type="button" :disabled="busy || locked || documentId === ''" @click="preview">
        {{ plan ? 'Проверить снова' : 'Извлечь знаки из PDF' }}
      </button>
    </template>
    <p v-if="locked" role="status">Сначала примените или отмените правки открытого проекта.</p>
    <p v-if="busy" role="status">Разбор PDF или запись каталога… Это занимает несколько секунд.</p>
    <p v-if="error" role="alert" class="error">{{ error }}</p>
    <p v-if="notice" role="status">{{ notice }}</p>

    <div v-if="plan" class="import-plan">
      <p>
        Страницы {{ plan.pages?.first }}–{{ plan.pages?.last }}: изображений
        {{ plan.images.length }}, в каталог попадёт {{ plan.signCount }} знаков (с жёлтыми
        вариантами). Новых {{ plan.added }}, с изменённым изображением
        {{ plan.changedCodes.length }}, сменится только редакция источника {{ plan.relabelled }},
        без изменений {{ plan.unchanged }}, исключается из текущего набора {{ plan.retired }}.
      </p>
      <p v-if="unresolved.length" class="error" role="status">
        У {{ unresolved.length }} изображений номер не найден: укажите его или снимите отметку «в
        каталог».
      </p>
      <p v-if="plan.yellowRule" class="rule">
        {{ plan.document.code }}-{{ plan.document.edition }}, п. {{ plan.yellowRule.clause }}: «{{
          plan.yellowRule.text
        }}» Жёлтые варианты: {{ plan.yellowCodes.join(', ') || 'нет' }}.
      </p>
      <p v-else class="hint">
        Перечень знаков с жёлтым фоном в тексте PDF не найден — варианты «_ж» не создаются.
      </p>

      <fieldset class="toolbar">
        <legend>Изображения из PDF</legend>
        <label
          ><input v-model="filter" type="radio" value="attention" /> Требуют проверки ({{
            plan.images.filter(needsAttention).length
          }})</label
        >
        <label><input v-model="filter" type="radio" value="all" /> Все</label>
        <label
          >Номер или страница
          <input v-model="search" type="search" placeholder="Например, 1.34" />
        </label>
      </fieldset>
      <p class="hint">
        «Требуют проверки»: номер не найден или исправлен, несколько изображений одного номера
        (варианты «_v2», «_v3»), пример знака индивидуального проектирования (отмечен «&lt;*&gt;»).
      </p>
      <ul class="pdf-grid">
        <li
          v-for="image in shown"
          :key="image.key"
          :class="{ excluded: !included(image), missing: image.reason === 'no-label' }"
          :data-key="image.key"
        >
          <img
            :src="pdfSignImageUrl(plan.document.id, image.key)"
            :alt="`Изображение ${image.key}`"
            loading="lazy"
          />
          <span class="where">стр. {{ image.page }}{{ image.example ? ' · пример' : '' }}</span>
          <label
            >Номер
            <input
              :value="numberValue(image)"
              :disabled="busy || locked || !included(image)"
              inputmode="decimal"
              maxlength="14"
              @change="setNumber(image, $event)"
          /></label>
          <label class="check"
            ><input
              type="checkbox"
              :checked="included(image)"
              :disabled="busy || locked"
              @change="setIncluded(image, $event)"
            />
            в каталог</label
          >
          <strong v-if="image.code">{{ image.code }}</strong>
        </li>
      </ul>
      <p v-if="!shown.length" class="hint">Нет изображений по этому отбору.</p>

      <details v-if="plan.addedCodes.length">
        <summary>Новые знаки · {{ plan.addedCodes.length }}</summary>
        <p class="codes">{{ plan.addedCodes.join(', ') }}</p>
      </details>
      <details v-if="plan.retiredCodes.length" open>
        <summary>Исключаются из текущего набора · {{ plan.retiredCodes.length }}</summary>
        <p v-if="retiredOther.length" class="codes">{{ retiredOther.join(', ') }}</p>
        <p v-if="retiredDrawn.length" class="hint">
          Рисуются программой без PNG (скорость 3.24 и расстояние 8.1.1):
          <span class="codes">{{ retiredDrawn.join(', ') }}</span
          >.
        </p>
        <p class="hint">
          Проекты с закреплёнными редакциями продолжат показывать прежние PNG из истории; новые
          стойки эти коды не получат.
        </p>
      </details>
      <details v-if="plan.changedCodes.length" :open="plan.changedCodes.length <= 40">
        <summary>Изменённые изображения · {{ plan.changedCodes.length }}</summary>
        <ul class="sign-compare">
          <li v-for="code in changedShown" :key="code">
            <strong>{{ code }}</strong>
            <img :src="`/api/signs/${encodeURIComponent(code)}/image`" alt="Сейчас" />
            <span aria-hidden="true">→</span>
            <img v-if="newImage(code)" :src="newImage(code)!" alt="Из PDF" />
          </li>
        </ul>
        <p v-if="plan.changedCodes.length > changedShown.length" class="hint">
          Показаны первые {{ changedShown.length }}; остальные:
          {{ plan.changedCodes.slice(changedShown.length).join(', ') }}.
        </p>
      </details>
      <p v-if="stale" class="error" role="status">
        Номера изменены — нажмите «Проверить снова», чтобы увидеть итог перед записью.
      </p>
      <button
        type="button"
        :disabled="busy || locked || stale || plan.added + plan.updated + plan.retired === 0"
        @click="apply"
      >
        Записать каталог знаков и создать копию SQLite
      </button>
    </div>
  </div>
</template>

<style scoped>
.pdf-signs {
  display: flex;
  flex-wrap: wrap;
  align-items: end;
  gap: 0.8rem;
  margin: 1rem 0;
  padding: 1rem;
  border: 1px solid #d8e1eb;
  border-radius: 0.4rem;
}
.pdf-signs > h4,
.pdf-signs > p,
.import-plan {
  flex-basis: 100%;
  margin: 0;
}
.import-plan > * {
  margin: 0.6rem 0;
}
label {
  display: grid;
  gap: 0.25rem;
}
select,
input {
  padding: 0.5rem;
  font: inherit;
}
button {
  padding: 0.55rem 0.8rem;
  border: 1px solid #185ca5;
  border-radius: 0.35rem;
  background: #fff;
  color: #185ca5;
  cursor: pointer;
  font: inherit;
}
.hint {
  color: #526273;
  line-height: 1.5;
}
.error {
  color: #a22030;
  font-weight: 600;
}
.rule {
  padding: 0.5rem 0.7rem;
  border-left: 3px solid #d9a400;
  background: #fffbea;
}
.toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: end;
  gap: 1rem;
  border: 1px solid #d8e1eb;
  border-radius: 0.4rem;
}
.toolbar label:not(:last-child) {
  display: flex;
  align-items: center;
  gap: 0.3rem;
}
.pdf-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(9.5rem, 1fr));
  gap: 0.6rem;
  max-height: 36rem;
  overflow: auto;
  padding: 0;
  list-style: none;
}
.pdf-grid li {
  display: grid;
  gap: 0.3rem;
  padding: 0.5rem;
  border: 1px solid #d8e1eb;
  border-radius: 0.4rem;
  background: #fff;
}
.pdf-grid li.missing {
  border-color: #a22030;
}
.pdf-grid li.excluded img {
  opacity: 0.3;
}
.pdf-grid img {
  width: 100%;
  height: 5rem;
  object-fit: contain;
  background: repeating-conic-gradient(#eef2f6 0 25%, #fff 0 50%) 0 0 / 12px 12px;
}
.pdf-grid input:not([type='checkbox']) {
  padding: 0.3rem;
  width: 100%;
  box-sizing: border-box;
}
.where {
  color: #526273;
  font-size: 0.85rem;
}
.check {
  display: flex;
  align-items: center;
  gap: 0.3rem;
}
.codes {
  font-family: ui-monospace, monospace;
  font-size: 0.85rem;
  overflow-wrap: anywhere;
}
.sign-compare {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(14rem, 1fr));
  gap: 0.5rem;
  padding: 0;
  list-style: none;
}
.sign-compare li {
  display: flex;
  align-items: center;
  gap: 0.4rem;
}
.sign-compare img {
  width: 48px;
  height: 48px;
  object-fit: contain;
  border: 1px solid #d8e1eb;
  background: #fff;
}
</style>
