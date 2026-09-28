<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import {
  anchorCoordinates,
  movePlacement,
  placementCoordinates,
  WORKSPACE_HEIGHT,
  WORKSPACE_WIDTH,
} from '../domain/placement-workspace'
import type { Scheme } from '../domain/model'
import { figureDimensions } from '../domain/figure-dimensions'
import RoadworkSymbol from './RoadworkSymbol.vue'

type Placement = Scheme['placements'][number]
type Drag = {
  id: number
  pointerId: number
  clientX: number
  clientY: number
  deltaX: number
  deltaY: number
}

const props = defineProps<{ scheme: Scheme; selectedId: number | null; locked: boolean }>()
const emit = defineEmits<{ apply: [scheme: Scheme]; select: [id: number] }>()
const zoom = ref(0.5)
const drag = ref<Drag | null>(null)
const error = ref('')
const catalog = ref<Set<string>>(new Set())
const catalogUnavailable = ref(false)
const anchors = computed(() => anchorCoordinates(props.scheme))
const dimensions = computed(() => figureDimensions(props.scheme))
const guides = computed(() =>
  (['L0', 'L1', 'Z0', 'Z1', 'E', 'AX'] as const).map((name) => ({
    name,
    x: anchors.value[name],
  })),
)
const outsideCount = computed(
  () =>
    props.scheme.placements.filter((placement) => {
      const { x, y } = placementCoordinates(placement, anchors.value)
      return x < 0 || x > WORKSPACE_WIDTH || y < 0 || y > WORKSPACE_HEIGHT
    }).length,
)

onMounted(async () => {
  try {
    const response = await fetch('/api/signs')
    if (!response.ok) throw new Error('catalog unavailable')
    const signs = (await response.json()) as { code: string }[]
    catalog.value = new Set([
      ...signs.map((sign) => sign.code),
      ...Object.keys(props.scheme.signImages.revisions),
    ])
  } catch {
    catalogUnavailable.value = true
  }
})

function left(placement: Placement): number {
  return (
    placementCoordinates(placement, anchors.value).x +
    (drag.value?.id === placement.id ? drag.value.deltaX : 0)
  )
}

function top(placement: Placement): number {
  const baselineAdjustment =
    placement.kind === 'element' && placement.elementKind === 'text'
      ? (placement.fontSizeSvg ?? 14)
      : 0
  return (
    placementCoordinates(placement, anchors.value).y -
    baselineAdjustment +
    (drag.value?.id === placement.id ? drag.value.deltaY : 0)
  )
}

function beginDrag(event: PointerEvent, placement: Placement): void {
  if (props.locked || event.button !== 0) return
  emit('select', placement.id)
  error.value = ''
  drag.value = {
    id: placement.id,
    pointerId: event.pointerId,
    clientX: event.clientX,
    clientY: event.clientY,
    deltaX: 0,
    deltaY: 0,
  }
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
}

function updateDrag(event: PointerEvent): void {
  if (!drag.value || drag.value.pointerId !== event.pointerId) return
  drag.value.deltaX = Math.round((event.clientX - drag.value.clientX) / zoom.value)
  drag.value.deltaY = Math.round((event.clientY - drag.value.clientY) / zoom.value)
}

function finishDrag(event: PointerEvent): void {
  if (!drag.value || drag.value.pointerId !== event.pointerId) return
  const { id, deltaX, deltaY } = drag.value
  drag.value = null
  if (event.type === 'pointercancel' || (!deltaX && !deltaY)) return
  applyMovement(id, deltaX, deltaY)
}

function applyMovement(id: number, deltaX: number, deltaY: number): void {
  try {
    emit('apply', movePlacement(props.scheme, id, deltaX, deltaY))
    error.value = ''
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'Не удалось переместить объект.'
  }
}

function onKeydown(event: KeyboardEvent, placement: Placement): void {
  if (props.locked || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key))
    return
  event.preventDefault()
  const step = event.shiftKey ? 10 : 1
  const deltaX = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0
  const deltaY = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0
  emit('select', placement.id)
  applyMovement(placement.id, deltaX, deltaY)
}

function nameFor(placement: Placement): string {
  if (placement.kind === 'sign-post')
    return `Стойка № ${placement.id}: ${placement.signIds.join(', ')}`
  return `Элемент № ${placement.id}: ${placement.text || placement.elementKind}`
}
</script>

<template>
  <section aria-labelledby="workspace-title">
    <div class="heading">
      <div>
        <h2 id="workspace-title">Рабочая область объектов</h2>
        <p class="hint">
          Условные координаты проекта: перетащите объект или выделите его и нажмите стрелку (Shift +
          стрелка — 10 единиц). Изменение попадёт в историю и сохранится после скачивания копии v5.
        </p>
      </div>
      <label for="workspace-zoom">
        Масштаб просмотра
        <select id="workspace-zoom" v-model.number="zoom">
          <option :value="0.35">35%</option>
          <option :value="0.5">50%</option>
          <option :value="0.75">75%</option>
          <option :value="1">100%</option>
        </select>
      </label>
    </div>
    <p class="notice">
      Цветные участки показывают введённую размерную цепочку рисунка
      {{ scheme.template.code.toUpperCase() }}: отвод, участок перед фронтом, фронт работ{{
        scheme.template.code === 'b33' ? ' и выходной отвод' : ''
      }}. Масштаб условный; расстановка знаков и применимость схемы требуют предметной сверки.
    </p>
    <ol class="dimension-summary" aria-label="Сравнение размеров с рисунком ОДМ">
      <li v-for="part in dimensions" :key="part.part" :class="{ differs: !part.agreesWithFigure }">
        {{ part.title }}: {{ part.enteredMetres }} м (рисунок: {{ part.figureLabel }}){{
          part.agreesWithFigure ? '' : ' — сверить'
        }}
      </li>
    </ol>
    <p v-if="locked" class="hint" role="status">
      Сначала примените или отмените изменения в форме. Перемещение временно заблокировано.
    </p>
    <p v-if="catalogUnavailable" class="hint" role="status">
      Локальный каталог знаков недоступен; на местах изображений показаны коды.
    </p>
    <p v-if="outsideCount" class="hint" role="status">
      За пределами области: {{ outsideCount }}. Координаты сохранены; объект доступен в списке и
      форме свойств.
    </p>
    <p v-if="error" class="error" role="alert">{{ error }}</p>

    <div class="scroll" aria-label="Прокручиваемая координатная область">
      <div
        class="viewport"
        :style="{ width: `${WORKSPACE_WIDTH * zoom}px`, height: `${WORKSPACE_HEIGHT * zoom}px` }"
      >
        <div
          class="sheet"
          :style="{
            width: `${WORKSPACE_WIDTH}px`,
            height: `${WORKSPACE_HEIGHT}px`,
            transform: `scale(${zoom})`,
          }"
        >
          <div class="axis" aria-hidden="true"><span>Y = 466</span></div>
          <div
            v-for="part in dimensions"
            :key="part.part"
            class="dimension-segment"
            :class="`segment-${part.part}`"
            :style="{ left: `${part.startX}px`, width: `${part.endX - part.startX}px` }"
            aria-hidden="true"
          />
          <div
            v-for="guide in guides"
            :key="guide.name"
            class="guide"
            :style="{ left: `${guide.x}px` }"
            aria-hidden="true"
          >
            <span>{{ guide.name }}</span>
          </div>

          <button
            v-for="placement in scheme.placements"
            :key="placement.id"
            type="button"
            class="placement"
            :class="[
              placement.kind === 'sign-post' ? 'post' : 'element',
              placement.kind === 'sign-post' && placement.stand === 'right' ? 'stand-right' : '',
              placement.kind === 'element' && placement.elementKind === 'text' ? 'text-item' : '',
            ]"
            :style="{
              left: `${left(placement)}px`,
              top: `${top(placement)}px`,
              ...(placement.kind === 'element' && placement.elementKind !== 'text'
                ? {
                    minWidth: `${Math.max(placement.sizeSvg.width, 28)}px`,
                    minHeight: `${Math.max(placement.sizeSvg.height, 28)}px`,
                  }
                : {}),
            }"
            :aria-label="nameFor(placement)"
            :aria-pressed="selectedId === placement.id"
            :disabled="locked"
            :title="`${nameFor(placement)} · ${placement.position.anchor}`"
            @click="emit('select', placement.id)"
            @pointerdown="beginDrag($event, placement)"
            @pointermove="updateDrag"
            @pointerup="finishDrag"
            @pointercancel="finishDrag"
            @keydown="onKeydown($event, placement)"
          >
            <template v-if="placement.kind === 'sign-post'">
              <span v-if="placement.stand === 'left'" class="pin" aria-hidden="true" />
              <span v-for="(code, index) in placement.signIds" :key="index" class="sign">
                <img
                  v-if="catalog.has(code)"
                  :src="`/api/signs/${encodeURIComponent(code)}/image${scheme.signImages.revisions[code] ? `?rev=${scheme.signImages.revisions[code]}` : ''}`"
                  alt=""
                  draggable="false"
                />
                <span v-else>{{ code }}</span>
              </span>
              <span v-if="placement.stand === 'right'" class="pin" aria-hidden="true" />
              <small class="object-id">№ {{ placement.id }}</small>
            </template>
            <template v-else-if="placement.elementKind === 'text'">
              <span
                :style="{
                  fontSize: `${placement.fontSizeSvg ?? 14}px`,
                  fontWeight: placement.bold ? 700 : 400,
                }"
              >
                {{ placement.text }}
              </span>
              <small class="object-id">№ {{ placement.id }}</small>
            </template>
            <template v-else>
              <RoadworkSymbol
                :kind="placement.elementKind"
                :width="placement.sizeSvg.width"
                :height="placement.sizeSvg.height"
                :known-signs="catalog"
                :revisions="scheme.signImages.revisions"
              />
              <small class="object-id">№ {{ placement.id }}</small>
            </template>
          </button>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.heading {
  display: flex;
  align-items: start;
  justify-content: space-between;
  gap: 1.25rem;
  flex-wrap: wrap;
}
h2 {
  margin: 0 0 0.5rem;
  font-size: 1.4rem;
}
.hint {
  color: #526273;
  font-size: 0.9rem;
  line-height: 1.5;
}
.heading .hint {
  max-width: 45rem;
  margin: 0;
}
label {
  color: #192534;
  font-size: 0.9rem;
  font-weight: 600;
}
select {
  display: block;
  margin-top: 0.3rem;
  padding: 0.4rem;
  border: 1px solid #93a5b8;
  border-radius: 0.35rem;
  background: #fff;
  font: inherit;
}
.notice {
  margin: 1rem 0;
  padding: 0.8rem 1rem;
  border-left: 4px solid #b87a20;
  background: #fff6e8;
  line-height: 1.5;
}
.dimension-summary {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem 1.5rem;
  margin: 0 0 1rem;
  padding-left: 1.5rem;
  font-size: 0.9rem;
}
.dimension-summary .differs {
  color: #9b2934;
  font-weight: 600;
}
.error {
  color: #a22030;
  font-weight: 600;
}
.scroll {
  width: 100%;
  max-height: 43rem;
  overflow: auto;
  border: 1px solid #b5c6d6;
  border-radius: 0.4rem;
  background: #e6edf3;
}
.viewport {
  position: relative;
}
.sheet {
  position: absolute;
  inset: 0 auto auto 0;
  transform-origin: top left;
  background-color: #fff;
  background-image:
    linear-gradient(#e9eef4 1px, transparent 1px),
    linear-gradient(90deg, #e9eef4 1px, transparent 1px);
  background-size: 50px 50px;
}
.axis {
  position: absolute;
  top: 466px;
  left: 0;
  width: 100%;
  border-top: 2px solid #9baec1;
  color: #53677a;
}
.axis span {
  margin-left: 10px;
  padding: 0.15rem;
  background: #fff;
  font-size: 13px;
}
.dimension-segment {
  position: absolute;
  top: 470px;
  height: 38px;
  box-sizing: border-box;
  border: 2px solid #9b6b23;
  background: repeating-linear-gradient(45deg, #f4bb6a88 0 10px, #fff7e988 10px 20px);
  pointer-events: none;
}
.segment-buffer {
  border-color: #427e9e;
  background: #9ecbd088;
}
.segment-front {
  border: 3px dashed #a76a04;
  background: #f59e0b66;
}
.guide {
  position: absolute;
  top: 0;
  height: 100%;
  border-left: 2px dashed #b1c9df;
  color: #356187;
}
.guide span {
  position: absolute;
  top: 9px;
  left: 3px;
  padding: 2px;
  background: #fff;
  font-size: 13px;
  font-weight: 700;
}
.placement {
  position: absolute;
  z-index: 1;
  box-sizing: border-box;
  border: 2px solid #5b7895;
  border-radius: 4px;
  background: #fff;
  color: #192534;
  cursor: grab;
  font: inherit;
  touch-action: none;
  user-select: none;
}
.placement:active {
  cursor: grabbing;
}
.placement[aria-pressed='true'] {
  z-index: 2;
  border-color: #0f5da7;
  box-shadow: 0 0 0 3px #0f5da766;
}
.placement:focus-visible {
  outline: 3px solid #0f5da7;
  outline-offset: 3px;
}
.placement:disabled {
  cursor: not-allowed;
  opacity: 0.6;
}
.post {
  display: flex;
  align-items: center;
  gap: 2px;
  min-height: 42px;
  padding: 1px;
  transform: translateY(-50%);
  white-space: nowrap;
}
.stand-right {
  transform: translate(-100%, -50%);
}
.pin {
  flex: 0 0 7px;
  height: 22px;
  border-left: 4px solid #193247;
}
.sign {
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 34px;
  height: 38px;
  overflow: hidden;
  font-size: 12px;
}
.sign img {
  max-width: 80px;
  height: 38px;
  object-fit: contain;
}
.object-id {
  position: absolute;
  top: -23px;
  left: 0;
  padding: 1px 3px;
  border-radius: 3px;
  background: #dbeaf7;
  color: #183a57;
  font-size: 12px;
  font-weight: 700;
}
.element {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 2px;
  background: #fcead4;
  font-size: 12px;
}
.text-item {
  align-items: start;
  border-style: dashed;
  background: #fffef8;
  white-space: pre-wrap;
}
</style>
