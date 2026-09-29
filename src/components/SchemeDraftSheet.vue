<script setup lang="ts">
import { computed, nextTick, onMounted, ref, useId } from 'vue'
import type { Scheme } from '../domain/model'
import { projectDraftSheet } from '../domain/draft-sheet'
import {
  drawableWithoutImage,
  drawSheet,
  objectsOutside,
  overlappingPosts,
  SHEET_HEIGHT,
  SHEET_WIDTH,
  type SignSize,
} from '../domain/sheet-drawing'
import SheetNodes from './SheetNodes.vue'

const props = defineProps<{
  scheme: Scheme
  hasPendingInput: boolean
  localRevision: number | null
  modifiedSinceLocalSave: boolean
  previewOnly?: boolean
}>()
const sheet = computed(() => projectDraftSheet(props.scheme))
const paper = ref<SVGSVGElement | null>(null)
const prefix = `sheet-${useId()}`
const zoom = ref(props.previewOnly ? 0.19 : 0.75)
const signSizes = ref<Map<string, SignSize>>(new Map())
const brokenImages = ref<Set<string>>(new Set())
const catalogState = ref<'loading' | 'ready' | 'partial' | 'unavailable'>('loading')
const catalogSource = ref<{ documentCode: string; edition: string } | null>(null)
const printError = ref('')

const revisionLabel = computed(() =>
  props.localRevision === null
    ? 'Проект не сохранён в SQLite.'
    : props.modifiedSinceLocalSave
      ? `Проект изменён после редакции № ${props.localRevision}.`
      : `Редакция проекта № ${props.localRevision}.`,
)
const drawing = computed(() =>
  drawSheet(sheet.value, {
    signSizes: signSizes.value,
    catalogLabel: catalogSource.value
      ? `Знаки: PNG локального архива · ${catalogSource.value.documentCode}, редакция ${catalogSource.value.edition}.`
      : 'Знаки: редакция каталога не указана.',
    revisionLabel: revisionLabel.value,
  }),
)
/** Знаки без PNG, которые нельзя нарисовать программно: печать с ними недопустима. */
const missingSigns = computed(() =>
  drawing.value.signCodes.filter(
    (code) =>
      (!signSizes.value.has(code) || brokenImages.value.has(code)) && !drawableWithoutImage(code),
  ),
)
/** Знаки, нарисованные программно вместо отсутствующего PNG. */
const drawnSigns = computed(() =>
  drawing.value.signCodes.filter(
    (code) =>
      (!signSizes.value.has(code) || brokenImages.value.has(code)) && drawableWithoutImage(code),
  ),
)
const outsideIds = computed(() => objectsOutside(drawing.value))
const previewSize = computed(() => ({
  width: `${1122.52 * zoom.value}px`,
  height: `${793.7 * zoom.value}px`,
}))

async function loadSigns(): Promise<void> {
  catalogState.value = 'loading'
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
    // Закреплённые в проекте редакции доступны из истории, даже если код исключён из архива.
    for (const code of Object.keys(props.scheme.signImages.revisions))
      if (!sizes.has(code)) sizes.set(code, { width: 1, height: 1 })
    signSizes.value = sizes
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
  return `/api/signs/${encodeURIComponent(code)}/image${revision ? `?rev=${revision}` : ''}`
}

function imageFailed(code: string): void {
  brokenImages.value = new Set([...brokenImages.value, code])
}

async function printDraft(): Promise<void> {
  printError.value = ''
  if (props.hasPendingInput || catalogState.value === 'loading') return
  if (catalogState.value !== 'ready') {
    printError.value = 'Для печати нужен полный доступ к локальному каталогу PNG знаков.'
    return
  }
  if (!catalogSource.value || catalogSource.value.edition === 'не указана') {
    printError.value = 'Для печати укажите редакцию ГОСТ при импорте локального архива PNG.'
    return
  }
  if (missingSigns.value.length) {
    printError.value = `В локальном архиве отсутствуют PNG: ${missingSigns.value.join(', ')}. Обновите архив или исправьте объекты.`
    return
  }
  if (outsideIds.value.length) {
    printError.value = `Объекты № ${outsideIds.value.join(', ')} выходят за пределы листа. Исправьте их положение перед печатью.`
    return
  }
  const overlap = overlappingPosts(drawing.value)[0]
  if (overlap) {
    printError.value = `Стойки № ${overlap[0]} и № ${overlap[1]} перекрываются. Разведите их перед печатью.`
    return
  }
  if (drawing.value.overflow.length) {
    printError.value = `Текст не помещается на листе: ${drawing.value.overflow.join(', ')}. Сократите реквизиты.`
    return
  }
  const schemeAtStart = props.scheme
  await nextTick()
  if (!paper.value) return
  // PNG знаков загружаются заранее: печать не должна начаться с пустыми местами на листе.
  const images = [...paper.value.querySelectorAll<SVGImageElement>('image[data-sign-code]')]
  await Promise.all(
    images.map(async (image) => {
      const probe = new Image()
      probe.src = image.href.baseVal
      try {
        await probe.decode()
      } catch {
        imageFailed(image.dataset.signCode ?? '')
      }
    }),
  )
  await nextTick()
  if (missingSigns.value.length) {
    printError.value = `Не удалось загрузить PNG: ${missingSigns.value.join(', ')}.`
    return
  }
  if (props.scheme !== schemeAtStart || props.hasPendingInput) {
    printError.value = 'Проект изменился во время подготовки печати. Проверьте лист и повторите.'
    return
  }
  window.print()
}
</script>

<template>
  <section
    :class="{ thumbnail: previewOnly }"
    :aria-labelledby="previewOnly ? undefined : 'sheet-title'"
    :aria-hidden="previewOnly ? true : undefined"
  >
    <div v-if="!previewOnly" class="screen-only">
      <h2 id="sheet-title">Черновой лист A4</h2>
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
          Печать черновика A4
        </button>
      </div>
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
        Нет PNG в локальном архиве: {{ missingSigns.join(', ') }}. Печать заблокирована до
        исправления.
      </p>
      <p v-if="catalogState === 'ready' && drawnSigns.length" class="hint" role="status">
        Нарисованы без PNG: {{ drawnSigns.join(', ') }}. Проверьте их вид или добавьте PNG в архив.
      </p>
      <p v-if="outsideIds.length" class="hint">
        За пределами листа: № {{ outsideIds.join(', ') }}. Их положение нужно исправить перед
        печатью.
      </p>
      <p v-if="printError" class="error" role="alert">{{ printError }}</p>
    </div>

    <div class="preview-scroll screen-preview" aria-label="Просмотр чернового листа A4">
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
@media print {
  .screen-only {
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
