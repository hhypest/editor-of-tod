<script setup lang="ts">
import { signImageUrl } from '../services/local-signs'
import { timed } from '../services/diagnostics'
import { useNormativeRules } from '../composables/useNormativeRules'
import { unmarkedChecks } from '../domain/review-marks'
import { reviewScheme } from '../domain/review-scheme'
import { releaseProblems } from '../domain/release-readiness'
import { templateLabel } from '../domain/registry'
import { computed, nextTick, onMounted, ref, useId, watch } from 'vue'
import type { Scheme } from '../domain/model'
import { projectDraftSheet } from '../domain/draft-sheet'
import {
  drawableWithoutImage,
  drawnSignBase,
  drawSheet,
  objectsOutside,
  overlappingPosts,
  SHEET_HEIGHT,
  SHEET_WIDTH,
  type SignSize,
} from '../domain/sheet-drawing'
import { downloadBlob, sheetFileName, sheetToPng } from '../services/sheet-png'
import { listDocuments } from '../services/local-documents'
import {
  catalogEditionStatus,
  documentLabel,
  type DocumentRecord,
} from '../domain/normative-documents'
import { localCalendarDate } from '../domain/pu66-review'
import SheetNodes from './SheetNodes.vue'

const props = defineProps<{
  scheme: Scheme
  hasPendingInput: boolean
  localRevision: number | null
  modifiedSinceLocalSave: boolean
  previewOnly?: boolean
}>()
const { rules: normativeRules } = useNormativeRules()
const sheet = computed(() => projectDraftSheet(props.scheme, normativeRules.value))
const paper = ref<SVGSVGElement | null>(null)
const prefix = `sheet-${useId()}`
const zoom = ref(props.previewOnly ? 0.19 : 0.75)
const signSizes = ref<Map<string, SignSize>>(new Map())
const brokenImages = ref<Set<string>>(new Set())
const catalogState = ref<'loading' | 'ready' | 'partial' | 'unavailable'>('loading')
const catalogSource = ref<{ documentCode: string; edition: string } | null>(null)
const printError = ref('')
const documents = ref<DocumentRecord[]>([])
/** Редакция знаков проекта (закреплённая или текущего каталога) против действующей в библиотеке. */
const editionStatus = computed(() =>
  catalogEditionStatus(catalogSource.value, documents.value, localCalendarDate(new Date())),
)
/** Составитель подтвердил проверку листа; сбрасывается при любом изменении проекта. */
const releaseConfirmed = ref(false)
const exporting = ref(false)
watch(
  () => props.scheme,
  () => {
    releaseConfirmed.value = false
  },
)

const revisionLabel = computed(() =>
  props.localRevision === null
    ? 'Проект не сохранён в SQLite.'
    : props.modifiedSinceLocalSave
      ? `Проект изменён после редакции № ${props.localRevision}.`
      : `Редакция проекта № ${props.localRevision}.`,
)
const drawingOptions = computed(() => ({
  signSizes: signSizes.value,
  catalogLabel: catalogSource.value
    ? `Знаки: PNG локального каталога · ${catalogSource.value.documentCode}, редакция ${catalogSource.value.edition}.`
    : 'Знаки: редакция каталога не указана.',
  revisionLabel: revisionLabel.value,
}))
/** Черновая раскладка: по ней выполняются все проверки (выпуск отличается только подписями). */
const draftDrawing = computed(() => drawSheet(sheet.value, drawingOptions.value))
/** Знаки без PNG, которые нельзя нарисовать программно: печать с ними недопустима. */
const missingSigns = computed(() =>
  draftDrawing.value.signCodes.filter(
    (code) =>
      (!signSizes.value.has(code) || brokenImages.value.has(code)) && !drawableWithoutImage(code),
  ),
)
/** Знаки, нарисованные программно вместо отсутствующего PNG. */
const drawnSigns = computed(() =>
  draftDrawing.value.signCodes.filter(
    (code) =>
      (!signSizes.value.has(code) || brokenImages.value.has(code)) && drawableWithoutImage(code),
  ),
)
/** Число нанесено поверх изображения стандарта (3.24, 8.1.1, 8.2.1) — вид совпадает с ГОСТ. */
const drawnOverBase = computed(() =>
  drawnSigns.value.filter((code) => {
    const base = drawnSignBase(code)
    return base !== null && signUrl(base) !== null
  }),
)
/** Изображения-основы нет в каталоге: знак нарисован целиком программой. */
const drawnWithoutBase = computed(() =>
  drawnSigns.value.filter((code) => !drawnOverBase.value.includes(code)),
)
const outsideIds = computed(() => objectsOutside(draftDrawing.value))
/** Причины, по которым лист нельзя печатать или выгружать; проверяются и при Ctrl+P. */
const blockers = computed(() => {
  const list: string[] = []
  if (props.hasPendingInput) list.push('Сначала примените или отмените изменения в форме.')
  if (catalogState.value === 'loading') list.push('Каталог знаков ещё загружается.')
  else if (catalogState.value !== 'ready')
    list.push('Для печати нужен полный доступ к локальному каталогу PNG знаков.')
  else if (!catalogSource.value || catalogSource.value.edition === 'не указана')
    list.push(
      'Для печати загрузите каталог знаков с указанием редакции ГОСТ (из PDF в библиотеке или ZIP).',
    )
  if (missingSigns.value.length)
    list.push(
      `В локальном каталоге нет PNG: ${missingSigns.value.join(', ')}. Обновите каталог знаков или исправьте объекты.`,
    )
  if (outsideIds.value.length)
    list.push(
      `Объекты № ${outsideIds.value.join(', ')} выходят за пределы листа. Исправьте их положение.`,
    )
  const overlap = overlappingPosts(draftDrawing.value)[0]
  if (overlap) list.push(`Стойки № ${overlap[0]} и № ${overlap[1]} перекрываются. Разведите их.`)
  if (draftDrawing.value.overflow.length)
    list.push(
      `Текст не помещается на листе: ${draftDrawing.value.overflow.join(', ')}. Сократите реквизиты.`,
    )
  return list
})
/** Пункты «Проверить вручную» без действующей отметки: выпуск листа недоступен. */
const uncheckedItems = computed(() =>
  unmarkedChecks(props.scheme, reviewScheme(props.scheme, normativeRules.value)),
)
const releaseErrors = computed(() => releaseProblems(props.scheme))
/** Повторная проверка непосредственно перед печатью/PNG и при Ctrl+P. */
const outputBlockers = computed(() => [
  ...blockers.value,
  ...(releaseConfirmed.value ? releaseErrors.value : []),
])
/** Выпускной лист только после подтверждения, отметки всех проверок и без блокирующих замечаний. */
const release = computed(
  () =>
    releaseConfirmed.value &&
    !blockers.value.length &&
    !uncheckedItems.value.length &&
    !releaseErrors.value.length,
)
const drawing = computed(() =>
  release.value
    ? drawSheet(sheet.value, { ...drawingOptions.value, release: true })
    : draftDrawing.value,
)
const previewSize = computed(() => ({
  width: `${1122.52 * zoom.value}px`,
  height: `${793.7 * zoom.value}px`,
}))

async function loadSigns(): Promise<void> {
  catalogState.value = 'loading'
  // Библиотека документов необязательна: без неё лист работает как раньше.
  listDocuments()
    .then((list) => (documents.value = list))
    .catch(() => (documents.value = []))
  brokenImages.value = new Set()
  try {
    const [response, sourceResponse] = await Promise.all([
      fetch('/api/signs'),
      fetch('/api/signs/catalog'),
    ])
    if (!response.ok || !sourceResponse.ok) throw new Error('Каталог недоступен')
    const list = (await response.json()) as Array<{ code: string; width: number; height: number }>
    const currentCatalog = (await sourceResponse.json()) as {
      documentCode: string
      edition: string
    } | null
    if (!Array.isArray(list)) throw new Error('Неверный ответ каталога')
    const sizes = new Map(
      list.map((sign) => [sign.code, { width: sign.width, height: sign.height }]),
    )
    // Закреплённые редакции доступны из истории, даже если код исключён из активного архива.
    // Их пропорции берутся из самого исторического PNG, а не из текущего каталога.
    const historic = Object.entries(props.scheme.signImages.revisions).filter(
      ([code]) => !sizes.has(code),
    )
    const broken = new Set<string>()
    await Promise.all(
      historic.map(async ([code, revision]) => {
        const probe = new Image()
        probe.src = signImageUrl(code, revision)
        try {
          await probe.decode()
          sizes.set(code, { width: probe.naturalWidth, height: probe.naturalHeight })
        } catch {
          broken.add(code)
        }
      }),
    )
    signSizes.value = sizes
    brokenImages.value = broken
    catalogSource.value = props.scheme.signImages.catalog ?? currentCatalog
    catalogState.value = list.length === 2_000 ? 'partial' : 'ready'
  } catch {
    signSizes.value = new Map()
    catalogSource.value = null
    catalogState.value = 'unavailable'
  }
}

onMounted(loadSigns)

function signUrl(code: string): string | null {
  if (!signSizes.value.has(code) || brokenImages.value.has(code)) return null
  const revision = props.scheme.signImages.revisions[code]
  return signImageUrl(code, revision)
}

function imageFailed(code: string): void {
  brokenImages.value = new Set([...brokenImages.value, code])
}

/** PNG знаков загружаются заранее: лист не должен уйти в печать или файл с пустыми местами. */
async function prepareSheet(): Promise<boolean> {
  printError.value = ''
  if (outputBlockers.value.length) {
    printError.value = outputBlockers.value[0]!
    return false
  }
  const schemeAtStart = props.scheme
  await nextTick()
  if (!paper.value) return false
  const images = [
    ...paper.value.querySelectorAll<SVGImageElement>(
      'image[data-sign-code], image[data-sign-base]',
    ),
  ]
  await Promise.all(
    images.map(async (image) => {
      const probe = new Image()
      probe.src = image.href.baseVal
      try {
        await probe.decode()
      } catch {
        imageFailed(image.dataset.signCode ?? image.dataset.signBase ?? '')
      }
    }),
  )
  await nextTick()
  if (outputBlockers.value.length) {
    printError.value = outputBlockers.value[0]!
    return false
  }
  if (missingSigns.value.length) {
    printError.value = `Не удалось загрузить PNG: ${missingSigns.value.join(', ')}.`
    return false
  }
  if (props.scheme !== schemeAtStart || props.hasPendingInput) {
    printError.value = 'Проект изменился во время подготовки. Проверьте лист и повторите.'
    return false
  }
  return true
}

async function printDraft(): Promise<void> {
  if (await prepareSheet()) window.print()
}

function fileName(extension: string): string {
  return sheetFileName(
    [
      'Схема',
      templateLabel(sheet.value.template).replace('.', ''),
      sheet.value.crossingFromPu66?.location || sheet.value.referenceId,
      release.value ? '' : 'черновик',
    ],
    extension,
  )
}

async function exportPng(): Promise<void> {
  if (exporting.value) return
  exporting.value = true
  try {
    if (!(await prepareSheet()) || !paper.value) return
    // Имя и режим фиксируются вместе со снимком листа: смена отметки или правка проекта во время
    // выгрузки отменяет её, чтобы файл не получил имя другого режима.
    const schemeAtStart = props.scheme
    const releaseAtStart = release.value
    const name = fileName('png')
    const blob = await timed('Выгрузка листа PNG', () =>
      sheetToPng(paper.value!, SHEET_WIDTH, SHEET_HEIGHT),
    )
    if (props.scheme !== schemeAtStart || release.value !== releaseAtStart) {
      printError.value = 'Лист изменился во время выгрузки PNG. Проверьте его и повторите.'
      return
    }
    downloadBlob(blob, name)
  } catch (cause) {
    printError.value = cause instanceof Error ? cause.message : 'Не удалось сформировать PNG.'
  } finally {
    exporting.value = false
  }
}
</script>

<template>
  <section
    :class="{ thumbnail: previewOnly }"
    :aria-labelledby="previewOnly ? undefined : 'sheet-title'"
    :aria-hidden="previewOnly ? true : undefined"
  >
    <div v-if="!previewOnly" class="screen-only">
      <h2 id="sheet-title">{{ release ? 'Выпускной лист A4' : 'Черновой лист A4' }}</h2>
      <p class="hint">
        Лист показывает применённые данные проекта и условные координаты объектов. Он не строит
        нормативную расстановку и не предназначен для передачи на согласование. Для проверки
        используйте обезличенные примеры; рабочие листы остаются только на вашем компьютере.
      </p>
      <div class="controls">
        <label for="sheet-zoom">
          Масштаб просмотра
          <select id="sheet-zoom" v-model.number="zoom">
            <option :value="0.6">60%</option>
            <option :value="0.75">75%</option>
            <option :value="0.9">90%</option>
            <option :value="1">100%</option>
            <option :value="1.25">125%</option>
          </select>
        </label>
        <button type="button" :disabled="catalogState === 'loading'" @click="loadSigns">
          Обновить PNG
        </button>
        <button
          type="button"
          class="print-button"
          :disabled="hasPendingInput || catalogState === 'loading'"
          @click="printDraft"
        >
          {{ release ? 'Печать листа A4' : 'Печать черновика A4' }}
        </button>
        <button
          type="button"
          :disabled="hasPendingInput || catalogState === 'loading' || exporting"
          @click="exportPng"
        >
          {{ exporting ? 'Формируется PNG…' : 'Скачать PNG' }}
        </button>
      </div>
      <fieldset class="release">
        <legend>Выпуск листа</legend>
        <label class="checkbox">
          <input
            v-model="releaseConfirmed"
            type="checkbox"
            :disabled="
              Boolean(blockers.length) ||
              Boolean(uncheckedItems.length) ||
              Boolean(releaseErrors.length) ||
              exporting
            "
          />
          Я проверил лист: знаки, расстояния, реквизиты и применимость схемы к условиям работ
        </label>
        <p class="hint">
          {{
            blockers.length
              ? 'Выпуск недоступен, пока есть замечания ниже.'
              : releaseErrors.length
                ? `Выпуск недоступен: ${releaseErrors.join(' ')}`
                : uncheckedItems.length
                  ? `Выпуск недоступен: не отмечены пункты «Проверить вручную» (${uncheckedItems.length}): ${uncheckedItems.map((item) => item.title).join('; ')}.`
                  : release
                    ? 'Выпускной лист: без отметки «черновик» и служебных строк. Любое изменение проекта возвращает черновик.'
                    : 'После отметки лист печатается и выгружается без отметки «черновик». Отметка не сохраняется в проекте и не заменяет согласование.'
          }}
        </p>
      </fieldset>
      <p class="hint">
        Пустые текстовые реквизиты допускается заполнить от руки на бумажном листе. Это не
        распространяется на расстояния, местоположение, типоразмер и объекты схемы.
      </p>
      <p v-if="hasPendingInput" class="hint" role="status">
        Сначала примените или отмените изменения в форме.
      </p>
      <p v-if="catalogState === 'unavailable' || catalogState === 'partial'" class="hint">
        {{
          catalogState === 'unavailable'
            ? 'Локальный каталог знаков недоступен; на листе показаны коды вместо PNG.'
            : 'Каталог содержит не менее 2000 записей: полный список для печати не получен.'
        }}
      </p>
      <p v-if="catalogState === 'ready' && missingSigns.length" class="error" role="status">
        Нет PNG в локальном каталоге: {{ missingSigns.join(', ') }}. Печать заблокирована до
        исправления.
      </p>
      <p v-if="catalogState === 'ready' && drawnOverBase.length" class="hint" role="status">
        Число нанесено программой поверх изображения стандарта: {{ drawnOverBase.join(', ') }}.
      </p>
      <p v-if="catalogState === 'ready' && drawnWithoutBase.length" class="hint" role="status">
        Нарисованы без изображения стандарта: {{ drawnWithoutBase.join(', ') }}. Извлеките в каталог
        знаки 3.24, 8.1.1 и 8.2.1 из ГОСТ Р 52290, чтобы вид совпадал со стандартом.
      </p>
      <p v-if="editionStatus.kind === 'outdated'" class="error" role="status">
        Знаки {{ scheme.signImages.catalog ? 'проекта закреплены' : 'каталога загружены' }} по
        редакции {{ editionStatus.catalogEdition }}, а в библиотеке действует
        {{ documentLabel(editionStatus.document) }}.
        {{
          scheme.signImages.catalog
            ? 'После загрузки каталога новой редакции проверьте знаки и закрепите редакции PNG заново на этапе «Знаки и объекты».'
            : 'Извлеките знаки из PDF новой редакции в «Реестры» → «Импорт Excel и знаков».'
        }}
      </p>
      <p v-if="outsideIds.length" class="hint">
        За пределами листа: № {{ outsideIds.join(', ') }}. Их положение нужно исправить перед
        печатью.
      </p>
      <p v-if="printError" class="error" role="alert">{{ printError }}</p>
    </div>

    <div v-if="!previewOnly && outputBlockers.length" class="print-blocked-note">
      <strong>Печать остановлена.</strong>
      <p v-for="reason in outputBlockers" :key="reason">{{ reason }}</p>
    </div>
    <div
      class="preview-scroll screen-preview"
      :class="{ blocked: outputBlockers.length }"
      aria-label="Просмотр листа A4"
    >
      <div class="preview-space" :style="previewSize">
        <svg
          ref="paper"
          class="sheet-paper"
          xmlns="http://www.w3.org/2000/svg"
          :viewBox="`0 0 ${SHEET_WIDTH} ${SHEET_HEIGHT}`"
          :style="previewSize"
          font-family="Arial, Helvetica, sans-serif"
          role="img"
          aria-label="Черновой лист схемы"
        >
          <defs>
            <pattern
              :id="`${prefix}-hatch`"
              width="9"
              height="9"
              patternUnits="userSpaceOnUse"
              patternTransform="rotate(-45)"
            >
              <rect width="9" height="9" fill="#fff" />
              <line x1="0" y1="0" x2="0" y2="9" stroke="#222" stroke-width="1.3" />
            </pattern>
            <marker
              :id="`${prefix}-arrow`"
              viewBox="0 0 10 10"
              refX="10"
              refY="5"
              markerWidth="9"
              markerHeight="6"
              orient="auto-start-reverse"
              markerUnits="userSpaceOnUse"
            >
              <path d="M0,0 L10,5 L0,10 z" fill="#000" />
            </marker>
            <symbol :id="`${prefix}-cone`" viewBox="0 0 30 34">
              <path d="M11 2 L19 2 L27 28 L3 28 Z" fill="#e4032e" />
              <path d="M9.2 11 L20.8 11 L22.6 17 L7.4 17 Z" fill="#fff" />
              <rect x="1" y="28" width="28" height="5" fill="#333" />
            </symbol>
            <symbol :id="`${prefix}-reg`" viewBox="0 0 60 80">
              <circle cx="24" cy="10" r="7" fill="#222" />
              <path
                d="M14 20 Q24 16 34 20 L36 50 L12 50 Z"
                fill="#ff7a00"
                stroke="#222"
                stroke-width="1.5"
              />
              <rect x="15" y="30" width="18" height="3" fill="#e6e6e6" />
              <rect x="15" y="38" width="18" height="3" fill="#e6e6e6" />
              <path d="M14 50 L12 76 L19 76 L23 54 L27 76 L34 76 L34 50 Z" fill="#222" />
              <path d="M34 24 L48 32" stroke="#222" stroke-width="4" stroke-linecap="round" />
              <circle cx="54" cy="35" r="5.5" fill="#e30613" stroke="#fff" stroke-width="1.5" />
              <path d="M14 24 L8 44" stroke="#222" stroke-width="4" stroke-linecap="round" />
            </symbol>
            <symbol :id="`${prefix}-truck`" viewBox="0 0 120 50">
              <rect
                x="4"
                y="10"
                width="72"
                height="28"
                fill="#f28c00"
                stroke="#222"
                stroke-width="2"
              />
              <rect
                x="76"
                y="16"
                width="30"
                height="22"
                rx="3"
                fill="#f28c00"
                stroke="#222"
                stroke-width="2"
              />
              <rect x="84" y="20" width="16" height="9" fill="#bfe0f5" stroke="#222" />
              <rect x="30" y="4" width="14" height="6" fill="#ffd200" stroke="#222" />
              <circle cx="22" cy="40" r="7" fill="#222" />
              <circle cx="90" cy="40" r="7" fill="#222" />
            </symbol>
          </defs>
          <rect :width="SHEET_WIDTH" :height="SHEET_HEIGHT" fill="#fff" />
          <SheetNodes
            :nodes="drawing.nodes"
            :sign-url="signUrl"
            :prefix="prefix"
            @image-error="imageFailed"
          />
        </svg>
      </div>
    </div>
  </section>
</template>

<style scoped>
h2 {
  margin: 0 0 0.6rem;
}
#sheet-title {
  scroll-margin-top: 1rem;
}
.hint {
  color: #526273;
  line-height: 1.5;
}
.error {
  color: #a22030;
  font-weight: 600;
}
.controls {
  display: flex;
  align-items: end;
  flex-wrap: wrap;
  gap: 0.8rem;
  margin: 1rem 0;
}
.controls label {
  font-weight: 600;
}
.controls select {
  display: block;
  padding: 0.45rem;
  font: inherit;
}
.controls button {
  padding: 0.55rem 0.85rem;
  font: inherit;
  cursor: pointer;
}
.controls button:disabled {
  cursor: not-allowed;
}
.print-button {
  color: white;
  border: 1px solid #175c9e;
  border-radius: 0.35rem;
  background: #175c9e;
}
.preview-scroll {
  overflow-x: auto;
  background: #e4ebf2;
  padding: 0.8rem;
}
.thumbnail .preview-scroll {
  overflow: hidden;
  padding: 0;
  background: white;
}
.thumbnail .sheet-paper {
  box-shadow: none;
}
.preview-space {
  position: relative;
}
.sheet-paper {
  display: block;
  background: white;
  box-shadow: 0 3px 12px #8e9eae;
}
.sheet-paper :deep(text) {
  white-space: pre;
}
.release {
  margin: 0 0 1rem;
  padding: 0.6rem 0.9rem;
  border: 1px solid #c6d3e0;
  border-radius: 0.45rem;
}
.release legend {
  font-weight: 600;
}
.release .checkbox {
  display: flex;
  gap: 0.5rem;
  align-items: flex-start;
}
.print-blocked-note {
  display: none;
}
@media print {
  .screen-only {
    display: none !important;
  }
  /* Ctrl+P в обход кнопки: вместо листа с ошибками печатается причина остановки. */
  .print-blocked-note {
    display: block;
    font:
      14pt/1.4 Arial,
      sans-serif;
  }
  .preview-scroll.blocked {
    display: none !important;
  }
  .preview-scroll {
    width: 297mm;
    height: 210mm;
    padding: 0;
    overflow: hidden;
    background: white;
  }
  .preview-space,
  .sheet-paper {
    width: 297mm !important;
    height: 209mm !important;
  }
  .sheet-paper {
    box-shadow: none;
    break-inside: avoid;
    print-color-adjust: exact;
    -webkit-print-color-adjust: exact;
  }
  .sheet-paper :deep(.draft-mark) {
    display: inline;
  }
}
</style>
