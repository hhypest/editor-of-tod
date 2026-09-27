<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue'
import type { Scheme } from '../domain/model'
import { projectDraftSheet } from '../domain/draft-sheet'
import RoadworkSymbol from './RoadworkSymbol.vue'

const props = defineProps<{
  scheme: Scheme
  hasPendingInput: boolean
  localRevision: number | null
  modifiedSinceLocalSave: boolean
}>()
const sheet = computed(() => projectDraftSheet(props.scheme))
const requiredSigns = computed(() => {
  const codes = sheet.value.placements.flatMap((item) =>
    item.kind === 'sign-post'
      ? item.signIds
      : item.elementKind === 'car'
        ? ['4.2.2']
        : item.elementKind === 'complex'
          ? ['1.25', '4.2.2']
          : [],
  )
  return [...new Set(codes)]
})
const missingSigns = computed(() =>
  requiredSigns.value.filter((code) => !knownSigns.value.has(code) || brokenImages.value.has(code)),
)
const usedSymbols = computed(
  () =>
    [
      ...new Set(
        sheet.value.placements
          .filter((item) => item.kind === 'element' && item.elementKind !== 'text')
          .map((item) => (item.kind === 'element' ? item.elementKind : 'pit')),
      ),
    ] as Array<'reg' | 'cone' | 'car' | 'complex' | 'pit'>,
)
const symbolLabels = {
  reg: 'Регулировщик с жезлом',
  cone: 'Дорожный конус',
  car: 'Машина прикрытия',
  complex: 'Переносной комплекс знаков',
  pit: 'Место работ',
}
function titleRow(label: string): string {
  return sheet.value.titleRows.find((row) => row.label === label)?.value ?? ''
}
const paper = ref<HTMLElement | null>(null)
const zoom = ref(0.75)
const knownSigns = ref<Set<string>>(new Set())
const brokenImages = ref<Set<string>>(new Set())
const catalogState = ref<'loading' | 'ready' | 'partial' | 'unavailable'>('loading')
const catalogSource = ref<{ documentCode: string; edition: string } | null>(null)
const printError = ref('')
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
    const list = (await response.json()) as Array<{ code: string }>
    catalogSource.value = (await sourceResponse.json()) as {
      documentCode: string
      edition: string
    } | null
    if (!Array.isArray(list)) throw new Error('Неверный ответ каталога')
    knownSigns.value = new Set(list.map((sign) => sign.code))
    catalogState.value = list.length === 2_000 ? 'partial' : 'ready'
  } catch {
    knownSigns.value = new Set()
    catalogSource.value = null
    catalogState.value = 'unavailable'
  }
}

onMounted(loadSigns)

function imageUrl(code: string): string {
  return `/api/signs/${encodeURIComponent(code)}/image`
}

function imageFailed(code: string): void {
  brokenImages.value = new Set([...brokenImages.value, code])
}

function printableText(value: string): string {
  return value.trim() || 'не указано'
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
  const schemeAtStart = props.scheme
  if (sheet.value.outsideIds.length) {
    printError.value = `Объекты № ${sheet.value.outsideIds.join(', ')} выходят за пределы рисунка. Исправьте их положение перед печатью.`
    return
  }
  await nextTick()
  if (missingSigns.value.length) {
    printError.value = `Не удалось загрузить PNG: ${missingSigns.value.join(', ')}.`
    return
  }
  if (!paper.value) return
  const page = paper.value
  const images = [...page.querySelectorAll<HTMLImageElement>('img[data-sign-code]')]
  await Promise.all(
    images.map(async (img) => {
      try {
        await img.decode()
      } catch {
        imageFailed(img.dataset.signCode ?? '')
      }
    }),
  )
  await nextTick()
  if (props.scheme !== schemeAtStart || props.hasPendingInput) {
    printError.value = 'Проект изменился во время подготовки печати. Проверьте лист и повторите.'
    return
  }
  const frame = page.querySelector<HTMLElement>('.drawing-frame')
  const frameBounds = frame?.getBoundingClientRect()
  const escaped = [...page.querySelectorAll<HTMLElement>('[data-object-id]')]
    .filter((object) => {
      if (!frameBounds) return true
      const bounds = object.getBoundingClientRect()
      return (
        bounds.left < frameBounds.left - 1 ||
        bounds.top < frameBounds.top - 1 ||
        bounds.right > frameBounds.right + 1 ||
        bounds.bottom > frameBounds.bottom + 1
      )
    })
    .map((object) => object.dataset.objectId)
  if (escaped.length) {
    printError.value = `Объекты № ${escaped.join(', ')} не помещаются на рисунке. Измените их положение или подписи.`
    return
  }
  const overflowing = [...page.querySelectorAll<HTMLElement>('[data-print-fit]')].some(
    (element) =>
      element.scrollHeight > element.clientHeight + 2 ||
      element.scrollWidth > element.clientWidth + 2,
  )
  if (overflowing) {
    printError.value =
      'Текст не помещается на черновом листе. Сократите реквизиты и проверьте просмотр.'
    return
  }
  window.print()
}
</script>

<template>
  <section aria-labelledby="sheet-title">
    <div class="screen-only">
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
      <p v-if="sheet.outsideIds.length" class="hint">
        За пределами рисунка: № {{ sheet.outsideIds.join(', ') }}. Их положение нужно исправить
        перед печатью.
      </p>
      <p v-if="printError" class="error" role="alert">{{ printError }}</p>
    </div>

    <div class="preview-scroll screen-preview" aria-label="Просмотр чернового листа A4">
      <div class="preview-space" :style="previewSize">
        <div ref="paper" class="sheet-paper" :style="{ transform: `scale(${zoom})` }">
          <header class="paper-header" data-print-fit>
            <div class="paper-signatures">
              <strong>Разработано</strong>
              <span>{{ printableText(titleRow('Разработчик')) }}</span>
              <span>{{ printableText(titleRow('Дата разработки')) }}</span>
            </div>
            <div class="paper-heading">
              <h3>Организация движения и ограждение зоны дорожных работ</h3>
              <strong
                >Железнодорожный переезд {{ sheet.referenceId }} · схема
                {{ sheet.template.toUpperCase() }}</strong
              >
              <span>Фронт {{ sheet.front }} м · {{ printableText(titleRow('Работы')) }}</span>
              <span
                >{{ printableText(sheet.location) }} · {{ printableText(titleRow('Период')) }}</span
              >
              <span>Ответственные: {{ printableText(titleRow('Ответственные')) }}</span>
            </div>
            <div class="paper-signatures right">
              <strong>Утверждает владелец дороги</strong>
              <span>{{ printableText(titleRow('Владелец дороги')) }}</span>
              <strong>Согласовывает Госавтоинспекция</strong>
              <span>{{ printableText(titleRow('Госавтоинспекция')) }}</span>
            </div>
          </header>
          <div class="draft-watermark">ЧЕРНОВИК · ДЛЯ ВНУТРЕННЕЙ СВЕРКИ</div>
          <div class="drawing-frame">
            <div class="drawing-stage">
              <div class="road" aria-hidden="true">
                <span class="road-arrow west">←</span><span class="road-arrow east">→</span>
                <div class="road-centre" />
              </div>
              <span class="direction left">{{ printableText(sheet.directions.left) }} ←</span>
              <span class="direction right">{{ printableText(sheet.directions.right) }} →</span>
              <div class="crossing-axis" :style="{ left: `${sheet.axisX}px` }" aria-hidden="true" />
              <span class="axis-label" :style="{ left: `${sheet.axisX}px` }">
                {{ sheet.crossingFromPu66?.axisLabel || 'Ось переезда' }}
              </span>
              <div
                v-for="segment in sheet.dimensionChain"
                :key="segment.part"
                class="zone-segment"
                :class="`segment-${segment.part}`"
                :style="{
                  left: `${segment.startX}px`,
                  width: `${segment.endX - segment.startX}px`,
                }"
                aria-hidden="true"
              />
              <div
                v-for="part in sheet.dimensionChain"
                :key="`dimension-${part.part}`"
                class="dimension"
                :style="{ left: `${part.startX}px`, width: `${part.endX - part.startX}px` }"
              >
                <span>{{ part.enteredMetres }} м</span>
              </div>
              <div
                v-for="item in sheet.placements"
                :key="item.id"
                class="placed-object"
                :class="
                  item.kind === 'sign-post'
                    ? 'sign-post'
                    : item.elementKind === 'text'
                      ? 'text-element'
                      : 'symbol-element'
                "
                :style="{ left: `${item.x}px`, top: `${item.y}px` }"
                :data-object-id="item.id"
              >
                <template v-if="item.kind === 'sign-post'">
                  <div class="post-signs">
                    <span v-for="(code, index) in item.signIds" :key="index" class="sign-face">
                      <img
                        v-if="knownSigns.has(code) && !brokenImages.has(code)"
                        :src="imageUrl(code)"
                        :alt="`Знак ${code}`"
                        :data-sign-code="code"
                        @error="imageFailed(code)"
                      />
                      <span v-else class="missing-sign">{{ code }}: нет PNG</span>
                    </span>
                  </div>
                  <span class="object-caption">№ {{ item.id }} {{ item.distanceLabel }}</span>
                </template>
                <template v-else-if="item.elementKind === 'text'">
                  <span
                    class="free-text"
                    :style="{ fontSize: `${item.fontSize}px`, fontWeight: item.bold ? 700 : 400 }"
                  >
                    {{ item.text }}
                  </span>
                </template>
                <template v-else>
                  <RoadworkSymbol
                    :kind="item.elementKind"
                    :width="item.width"
                    :height="item.height"
                    :known-signs="knownSigns"
                  />
                  <small class="symbol-id">№ {{ item.id }}</small>
                </template>
              </div>
            </div>
          </div>
          <footer class="paper-footer" data-print-fit>
            <div class="legend">
              <h4>Условные обозначения</h4>
              <div v-for="kind in usedSymbols" :key="kind">
                <RoadworkSymbol
                  :kind="kind"
                  :width="kind === 'car' ? 50 : 24"
                  :height="30"
                  :known-signs="knownSigns"
                />
                <span>{{ symbolLabels[kind] }}</span>
              </div>
              <p v-if="!usedSymbols.length">
                Условные обозначения добавляются составителем в редакторе.
              </p>
              <p>
                Знаки на стойках: PNG локального архива ·
                {{
                  catalogSource
                    ? `${catalogSource.documentCode}, редакция ${catalogSource.edition}`
                    : 'редакция не указана'
                }}.
              </p>
            </div>
            <div class="sheet-notes">
              <h4>Параметры и примечания</h4>
              <p>
                Проезжая часть:
                {{ printableText(sheet.crossingFromPu66?.carriagewayWidthMetres || '') }} м; дорога:
                {{ printableText(sheet.crossingFromPu66?.roadName || '') }}.
              </p>
              <p>
                Размеры: отвод {{ sheet.taper }} м, буфер {{ sheet.buffer }} м, фронт
                {{ sheet.front }} м. Скорости: {{ sheet.speeds.join(' / ') }} км/ч.
              </p>
              <p>
                Размерная цепочка на рисунке условна. Сверьте длины, расстановку, режим движения и
                актуальный источник.
              </p>
              <p>
                Проект {{ sheet.id }} ·
                {{
                  localRevision === null
                    ? 'не сохранён в SQLite'
                    : modifiedSinceLocalSave
                      ? `изменён после редакции № ${localRevision}`
                      : `редакция № ${localRevision}`
                }}. Нормативная применимость не подтверждена.
              </p>
            </div>
          </footer>
        </div>
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
.preview-space {
  position: relative;
}
.sheet-paper {
  width: 297mm;
  height: 210mm;
  box-sizing: border-box;
  padding: 7mm;
  display: grid;
  grid-template-rows: 39mm 115mm 38mm;
  gap: 2mm;
  overflow: hidden;
  position: relative;
  transform-origin: top left;
  background: white;
  color: #182533;
  font:
    8pt/1.25 Arial,
    sans-serif;
  box-shadow: 0 3px 12px #8e9eae;
}
.paper-header {
  display: grid;
  grid-template-columns: 1fr 2.6fr 1fr;
  gap: 3mm;
  overflow: hidden;
  overflow-wrap: anywhere;
}
.paper-signatures {
  display: flex;
  flex-direction: column;
  gap: 1mm;
  padding-top: 2mm;
}
.paper-signatures strong {
  font-size: 8pt;
}
.paper-signatures.right {
  padding-top: 0;
}
.paper-heading {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1mm;
  text-align: center;
}
.paper-heading h3 {
  font-size: 11pt;
  line-height: 1.16;
  margin: 0 0 1mm;
}
.paper-heading strong {
  font-size: 8pt;
}
.draft-watermark {
  position: absolute;
  top: 37mm;
  left: 79mm;
  right: 79mm;
  z-index: 3;
  padding: 0.5mm;
  background: white;
  color: #9b2934;
  font-size: 7pt;
  font-weight: 700;
  letter-spacing: 0.07em;
  text-align: center;
}
.drawing-frame {
  box-sizing: border-box;
  width: 283mm;
  height: 115mm;
  overflow: hidden;
  position: relative;
}
.drawing-stage {
  position: relative;
  left: 25px;
  width: 1680px;
  height: 720px;
  transform: scale(0.6);
  transform-origin: top left;
  background: white;
}
.road {
  position: absolute;
  top: 410px;
  left: 48px;
  width: 1584px;
  height: 112px;
  background: #bbb;
  border-top: 15px solid #e6e6e6;
  border-bottom: 15px solid #e6e6e6;
  box-sizing: border-box;
}
.road-centre {
  position: absolute;
  top: 48%;
  width: 100%;
  border-top: 3px dashed white;
}
.road-arrow {
  position: absolute;
  z-index: 1;
  color: white;
  font:
    bold 64px/1 Arial,
    sans-serif;
}
.road-arrow.west {
  top: 0;
  left: 45px;
}
.road-arrow.east {
  bottom: 0;
  right: 45px;
}
.direction {
  position: absolute;
  top: 348px;
  max-width: 210px;
  font-size: 20px;
}
.direction.left {
  left: 48px;
}
.direction.right {
  right: 48px;
  top: 545px;
  text-align: right;
}
.crossing-axis {
  position: absolute;
  z-index: 1;
  top: 228px;
  width: 6px;
  height: 380px;
  margin-left: -3px;
  background: #202020;
}
.axis-label {
  position: absolute;
  top: 230px;
  max-width: 160px;
  font-size: 17px;
  transform: rotate(-90deg) translateX(-100%);
  transform-origin: left top;
}
.zone-segment {
  position: absolute;
  top: 470px;
  height: 38px;
  box-sizing: border-box;
  border-top: 2px dashed #9c3232;
  background: repeating-linear-gradient(45deg, #ececec 0 8px, #fff 8px 18px);
  opacity: 0.65;
  pointer-events: none;
}
.segment-buffer {
  border-color: #4a677b;
  background: #ecf3f6;
}
.segment-front {
  border: 2px solid #4e4e4e;
  background: repeating-linear-gradient(45deg, #fff 0 11px, #84909a 11px 13px);
}
.dimension {
  position: absolute;
  top: 666px;
  height: 24px;
  box-sizing: border-box;
  border-top: 2px solid #222;
  text-align: center;
}
.dimension::before,
.dimension::after {
  content: '';
  position: absolute;
  bottom: 8px;
  width: 1px;
  height: 146px;
  background: #303030;
}
.dimension::before {
  left: 0;
}
.dimension::after {
  right: 0;
}
.dimension span {
  display: inline-block;
  position: relative;
  top: -25px;
  background: white;
  padding: 0 6px;
  font-size: 21px;
}
.placed-object {
  position: absolute;
  z-index: 2;
  max-width: 340px;
  overflow-wrap: anywhere;
}
.sign-post {
  transform: translateY(-50%);
}
.post-signs {
  display: flex;
  max-width: 330px;
  gap: 5px;
  align-items: center;
}
.sign-face {
  display: inline-grid;
  place-items: center;
  min-width: 51px;
  height: 62px;
  background: white;
}
.sign-face img {
  max-width: 70px;
  max-height: 62px;
  object-fit: contain;
}
.missing-sign {
  padding: 2px;
  background: #fff;
  color: #9b2934;
  font-size: 13px;
}
.object-caption {
  display: block;
  font-size: 14px;
  text-align: center;
}
.symbol-element {
  display: flex;
  align-items: center;
  justify-content: center;
}
.symbol-id {
  position: absolute;
  top: -17px;
  left: 0;
  font-size: 12px;
  background: #fff;
}
.free-text {
  white-space: pre-wrap;
}
.paper-footer {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 7mm;
  min-height: 0;
  overflow: hidden;
  padding-top: 2mm;
  border-top: 1px solid #777;
  overflow-wrap: anywhere;
  font-size: 7pt;
}
.paper-footer h4 {
  margin: 0 0 1mm;
  font-size: 9pt;
  text-decoration: underline;
}
.paper-footer p {
  margin: 1mm 0;
}
.legend > div {
  display: flex;
  align-items: center;
  gap: 2mm;
  min-height: 7mm;
}
.legend {
  display: grid;
  grid-template-columns: 1fr 1fr;
  align-content: start;
  gap: 0 2mm;
}
.legend h4,
.legend p {
  grid-column: 1 / -1;
}
.legend > div span:last-child {
  font-size: 6pt;
}
.sheet-notes p:last-child {
  color: #9b2934;
}
@media print {
  .screen-only {
    display: none !important;
  }
  .preview-scroll {
    width: 297mm;
    height: 210mm;
    padding: 0;
    overflow: visible;
    background: white;
  }
  .preview-space {
    width: 297mm !important;
    height: 210mm !important;
  }
  .sheet-paper {
    transform: none !important;
    box-shadow: none;
    break-inside: avoid;
  }
  .drawing-stage,
  .sheet-paper {
    print-color-adjust: exact;
    -webkit-print-color-adjust: exact;
  }
}
</style>
