<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue'
import type { Scheme } from '../domain/model'
import { projectDraftSheet } from '../domain/draft-sheet'

const props = defineProps<{
  scheme: Scheme
  hasPendingInput: boolean
  localRevision: number | null
  modifiedSinceLocalSave: boolean
}>()
const sheet = computed(() => projectDraftSheet(props.scheme))
const paper = ref<HTMLElement | null>(null)
const zoom = ref(0.75)
const knownSigns = ref<Set<string>>(new Set())
const brokenImages = ref<Set<string>>(new Set())
const catalogState = ref<'loading' | 'ready' | 'partial' | 'unavailable'>('loading')
const printError = ref('')
const previewSize = computed(() => ({
  width: `${1122.52 * zoom.value}px`,
  height: `${793.7 * zoom.value}px`,
}))

async function loadSigns(): Promise<void> {
  catalogState.value = 'loading'
  brokenImages.value = new Set()
  try {
    const response = await fetch('/api/signs')
    if (!response.ok) throw new Error('Каталог недоступен')
    const list = (await response.json()) as Array<{ code: string }>
    if (!Array.isArray(list)) throw new Error('Неверный ответ каталога')
    knownSigns.value = new Set(list.map((sign) => sign.code))
    // The existing API returns at most 500 records. A missing code is then inconclusive.
    catalogState.value = list.length === 500 ? 'partial' : 'ready'
  } catch {
    knownSigns.value = new Set()
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
  const schemeAtStart = props.scheme
  if (sheet.value.outsideIds.length) {
    printError.value = `Объекты № ${sheet.value.outsideIds.join(', ')} выходят за пределы рисунка. Исправьте их положение перед печатью.`
    return
  }
  await nextTick()
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
            : 'Каталог содержит не менее 500 записей: для кодов вне полученного списка показан текст.'
        }}
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
            <div>
              <p class="paper-kicker">Условный лист организации движения</p>
              <h3>Переезд {{ sheet.referenceId }} · {{ sheet.template.toUpperCase() }}</h3>
              <p>{{ printableText(sheet.location) }}</p>
            </div>
            <strong class="draft-mark">ЧЕРНОВИК<br />НЕ ДЛЯ СОГЛАСОВАНИЯ</strong>
          </header>

          <div class="paper-content">
            <div class="drawing-column">
              <div class="drawing-frame">
                <div class="drawing-stage">
                  <div class="road" aria-hidden="true"><div class="road-centre" /></div>
                  <div
                    class="crossing-axis"
                    :style="{ left: `${sheet.axisX}px` }"
                    aria-hidden="true"
                  />
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
                  <span class="axis-label" :style="{ left: `${sheet.axisX}px` }">Ось</span>
                  <div
                    v-for="item in sheet.placements"
                    :key="item.id"
                    class="placed-object"
                    :class="
                      item.kind === 'sign-post'
                        ? 'sign-post'
                        : item.elementKind === 'text'
                          ? 'placed-element text-element'
                          : 'placed-element'
                    "
                    :style="{
                      left: `${item.x}px`,
                      top: `${item.y}px`,
                      ...(item.kind === 'element' && item.elementKind !== 'text'
                        ? {
                            minWidth: `${Math.max(item.width, 28)}px`,
                            minHeight: `${Math.max(item.height, 28)}px`,
                          }
                        : {}),
                    }"
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
                          <span v-else>{{ code }}</span>
                        </span>
                      </div>
                      <span class="object-caption">№ {{ item.id }} {{ item.distanceLabel }}</span>
                    </template>
                    <template v-else-if="item.elementKind === 'text'">
                      <span
                        class="free-text"
                        :style="{
                          fontSize: `${item.fontSize}px`,
                          fontWeight: item.bold ? 700 : 400,
                        }"
                        >{{ item.text }}</span
                      >
                    </template>
                    <template v-else>{{ item.elementKind }} № {{ item.id }}</template>
                  </div>
                </div>
              </div>
              <p class="drawing-note">
                Условный эскиз. Координаты и длины на рисунке не являются масштабом местности.
              </p>
            </div>

            <aside class="paper-parameters" data-print-fit>
              <template v-if="sheet.crossingFromPu66">
                <h4>Сведения из закреплённой ПУ-66</h4>
                <dl>
                  <div>
                    <dt>Место переезда</dt>
                    <dd>{{ printableText(sheet.crossingFromPu66.location) }}</dd>
                  </div>
                  <div>
                    <dt>Подпись оси</dt>
                    <dd>{{ printableText(sheet.crossingFromPu66.axisLabel) }}</dd>
                  </div>
                  <div>
                    <dt>Автомобильная дорога</dt>
                    <dd>{{ printableText(sheet.crossingFromPu66.roadName) }}</dd>
                  </div>
                  <div>
                    <dt>Ширина проезжей части, м</dt>
                    <dd>{{ printableText(sheet.crossingFromPu66.carriagewayWidthMetres) }}</dd>
                  </div>
                </dl>
              </template>
              <h4>Введённые параметры</h4>
              <dl>
                <div>
                  <dt>Направления</dt>
                  <dd>
                    {{ printableText(sheet.directions.left) }} /
                    {{ printableText(sheet.directions.right) }}
                  </dd>
                </div>
                <div>
                  <dt>Фронт / отвод / буфер</dt>
                  <dd>{{ sheet.front }} / {{ sheet.taper }} / {{ sheet.buffer }} м</dd>
                </div>
                <div v-if="Object.values(sheet.zoneLabels).some(Boolean)">
                  <dt>Подписи зон</dt>
                  <dd>
                    {{
                      [sheet.zoneLabels.taper, sheet.zoneLabels.buffer, sheet.zoneLabels.work]
                        .filter(Boolean)
                        .join(' / ')
                    }}
                  </dd>
                </div>
                <div>
                  <dt>Скорости</dt>
                  <dd>{{ sheet.speeds.join(' / ') }} км/ч</dd>
                </div>
                <div>
                  <dt>Жёлтый фон</dt>
                  <dd>{{ sheet.yellowTemporarySigns ? 'да' : 'нет' }}</dd>
                </div>
                <div v-for="distance in sheet.distances" :key="distance.label">
                  <dt>{{ distance.label }}</dt>
                  <dd>{{ distance.value === null ? 'не указано' : `${distance.value} м` }}</dd>
                </div>
              </dl>
              <h4>Цепочка по рис. {{ sheet.template.toUpperCase() }}</h4>
              <table class="dimension-table">
                <thead>
                  <tr>
                    <th>Участок</th>
                    <th>Введено</th>
                    <th>Рисунок</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="part in sheet.dimensionChain" :key="part.part">
                    <th scope="row">{{ part.title }}</th>
                    <td>{{ part.enteredMetres }} м</td>
                    <td :class="{ 'dimension-differs': !part.agreesWithFigure }">
                      {{ part.figureLabel }}{{ part.agreesWithFigure ? '' : ' · сверить' }}
                    </td>
                  </tr>
                </tbody>
              </table>
              <p v-if="sheet.template === 'b34'" class="dimension-note">
                * Ровно 30 м по правилу проекта относится к Б.33.
              </p>
              <p>
                Стойки: {{ sheet.placements.filter((item) => item.kind === 'sign-post').length }};
                объектов всего: {{ sheet.placements.length }}.
              </p>
            </aside>
          </div>

          <footer class="paper-footer" data-print-fit>
            <div class="title-grid">
              <div v-for="row in sheet.titleRows" :key="row.label" class="title-row">
                <span>{{ row.label }}</span
                ><strong>{{ printableText(row.value) }}</strong>
              </div>
            </div>
            <p>
              Проект {{ sheet.id }} · {{ sheet.createdAt }} ·
              {{
                localRevision === null
                  ? 'нет сохранённой редакции SQLite'
                  : modifiedSinceLocalSave
                    ? `изменено после локальной редакции № ${localRevision}`
                    : `локальная редакция № ${localRevision}`
              }}. Нормативная применимость не подтверждена.
            </p>
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
  grid-template-rows: 23mm 132mm 1fr;
  gap: 3mm;
  overflow: hidden;
  position: relative;
  transform-origin: top left;
  background: white;
  color: #182533;
  font:
    9pt/1.3 Arial,
    sans-serif;
  box-shadow: 0 3px 12px #8e9eae;
}
.paper-header {
  display: flex;
  justify-content: space-between;
  gap: 5mm;
  overflow: hidden;
  border-bottom: 0.5mm solid #273e54;
}
.paper-header h3 {
  font-size: 15pt;
  margin: 0.7mm 0;
}
.paper-header p {
  margin: 0;
}
.paper-kicker {
  font-size: 8pt;
  text-transform: uppercase;
  letter-spacing: 0.03em;
}
.draft-mark {
  text-align: right;
  color: #9b2934;
  font-size: 10pt;
  white-space: nowrap;
}
.paper-content {
  display: grid;
  grid-template-columns: 178mm 100mm;
  gap: 5mm;
  min-height: 0;
}
.drawing-column {
  min-width: 0;
}
.drawing-frame {
  width: 178mm;
  height: 126mm;
  box-sizing: border-box;
  border: 0.3mm solid #8b9bad;
  overflow: hidden;
}
.drawing-stage {
  position: relative;
  width: 1680px;
  height: 1188px;
  transform: scale(0.4);
  transform-origin: top left;
  background: #f9fbfd;
}
.road {
  position: absolute;
  top: 410px;
  left: 80px;
  width: 1520px;
  height: 112px;
  border: 4px solid #566778;
  background: #e5ebf0;
}
.road-centre {
  position: absolute;
  top: 50%;
  width: 100%;
  border-top: 3px dashed #536576;
}
.crossing-axis {
  position: absolute;
  top: 215px;
  width: 48px;
  height: 526px;
  margin-left: -24px;
  background: repeating-linear-gradient(0deg, #627486 0 9px, #e3e8ed 9px 18px);
  opacity: 0.65;
}
.zone-segment {
  position: absolute;
  top: 410px;
  height: 120px;
  box-sizing: border-box;
  border: 2px solid #9b6b23;
  background: repeating-linear-gradient(45deg, #f4bb6a66 0 10px, #fff7e966 10px 20px);
  pointer-events: none;
}
.segment-buffer {
  border-color: #427e9e;
  background: #9ecbd066;
}
.segment-front {
  background: rgb(245 158 11 / 32%);
  border: 3px dashed #a76a04;
}
.axis-label {
  position: absolute;
  top: 193px;
  transform: translateX(-50%);
  font-size: 27px;
}
.placed-object {
  position: absolute;
  z-index: 1;
  max-width: 340px;
  overflow-wrap: anywhere;
}
.sign-post {
  background: #fff;
  border: 2px solid #2e4d65;
  padding: 4px;
}
.post-signs {
  display: flex;
  flex-wrap: wrap;
  max-width: 320px;
  gap: 3px;
}
.sign-face {
  display: inline-grid;
  place-items: center;
  min-width: 58px;
  height: 62px;
  border: 1px solid #526273;
  background: #fff;
  padding: 2px;
  font-size: 17px;
}
.sign-face img {
  max-width: 64px;
  max-height: 62px;
  object-fit: contain;
}
.object-caption {
  display: block;
  font-size: 16px;
}
.placed-element {
  min-width: 28px;
  min-height: 24px;
  border: 2px solid #455c70;
  background: #fff;
  font-size: 18px;
}
.text-element {
  border: 0;
  background: transparent;
}
.free-text {
  white-space: pre-wrap;
}
.drawing-note {
  font-size: 7pt;
  margin: 1mm 0 0;
}
.paper-parameters {
  border: 0.3mm solid #8b9bad;
  padding: 2mm;
  box-sizing: border-box;
  overflow: hidden;
  overflow-wrap: anywhere;
}
.paper-parameters h4 {
  margin: 1.5mm 0 1mm;
  font-size: 10pt;
}
.paper-parameters h4:first-child {
  margin-top: 0;
}
.paper-parameters dl {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 1.4mm;
  margin: 0;
}
.paper-parameters dl > div {
  border-bottom: 1px solid #d2dbe4;
  padding: 0.5mm 0;
}
.paper-parameters dt {
  font-size: 7pt;
  color: #526273;
}
.paper-parameters dd {
  margin: 0;
  font-weight: 600;
}
.dimension-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 7pt;
}
.dimension-table th,
.dimension-table td {
  padding: 1mm 0.7mm;
  text-align: left;
  border-bottom: 1px solid #d2dbe4;
}
.dimension-table th {
  font-weight: 500;
}
.dimension-table td:last-child {
  white-space: nowrap;
}
.dimension-differs {
  color: #9b2934;
  font-weight: 700;
}
.dimension-note {
  margin: 1mm 0 0;
  font-size: 7pt;
}
.paper-footer {
  min-height: 0;
  overflow: hidden;
  border-top: 0.5mm solid #273e54;
  padding-top: 1mm;
  box-sizing: border-box;
}
.title-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 1mm 4mm;
}
.title-row {
  display: grid;
  grid-template-columns: 26mm 1fr;
  gap: 1mm;
  border-bottom: 1px solid #d2dbe4;
  overflow-wrap: anywhere;
}
.title-row span {
  color: #526273;
}
.paper-footer p {
  font-size: 7pt;
  margin: 1.5mm 0 0;
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
