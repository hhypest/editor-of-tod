<script setup lang="ts">
import { computed } from 'vue'
import { drawnSignBase, ZONE_PLATE, type SheetNode } from '../domain/sheet-drawing'

const props = defineProps<{
  node: Extract<SheetNode, { t: 'sign' }>
  /** Адрес PNG из локального каталога; null — изображения нет. */
  href: string | null
  /** Изображение-основа из ГОСТ для дорисовываемого знака (3.24, 3.24_ж, 8.1.1, 8.2.1). */
  baseHref?: string | null
}>()
const emit = defineEmits<{ error: [code: string] }>()
const baseCode = computed(() => drawnSignBase(props.node.code) ?? props.node.code)

/** Фон знаков по ГОСТ Р 52290-2024: белый и жёлтый (тот же, что у извлечённых PNG). */
const WHITE = '#ffffff'
const YELLOW = '#fedc00'
/**
 * Шрифт числа. Цифры знаков узкие и полужирные; Bahnschrift (Windows 10 и новее) близок к
 * шрифту дорожных знаков, остальные — запасные. Ширина задаётся `textLength`, поэтому
 * пропорции числа совпадают с изображением стандарта при любом доступном шрифте.
 */
const FONT =
  "'Bahnschrift SemiBold Condensed', Bahnschrift, 'Arial Narrow', 'Roboto Condensed', 'DejaVu Sans Condensed', sans-serif"

/** Знак 3.24 с числом: значение скорости и фон. */
const speed = computed(() => {
  const match = /^3\.24(?:_(\d+))?(_ж)?$/.exec(props.node.code)
  if (!match) return null
  const value = match[1] ?? '50'
  const { x, y, w, h } = props.node
  const size = Math.min(w, h)
  // Пропорции измерены по изображению 3.24 ГОСТ Р 52290-2024: цифры «50» занимают 0,35 высоты
  // и 0,49 ширины знака, внутренний край красного кольца — 0,38 высоты от центра.
  const digits = value.length
  const height = size * (digits > 2 ? 0.28 : 0.35)
  const width = size * (digits > 2 ? 0.58 : digits === 1 ? 0.24 : 0.485)
  return {
    value,
    fill: match[2] ? YELLOW : WHITE,
    cx: x + w / 2,
    cy: y + h / 2,
    cover: size * 0.36,
    ring: size / 2,
    textX: x + w / 2,
    baseline: y + h / 2 + height / 2,
    fontSize: height / 0.72,
    textLength: width,
  }
})
/** Табличка 8.1.1: расстояние до объекта. */
const plate = computed(() => {
  const value = /^8\.1\.1_(\d+)$/.exec(props.node.code)?.[1]
  if (!value) return null
  const { x, y, w, h } = props.node
  const text = `${value} м`
  // По изображению 8.1.1 ГОСТ: надпись «300 м» — 0,82 ширины, цифры — 0,49 высоты таблички.
  return {
    text,
    x,
    y,
    w,
    h,
    baseline: y + h * 0.745,
    fontSize: (h * 0.49) / 0.72,
    textLength: Math.min(0.86, (0.82 * text.length) / 5) * w,
  }
})
/**
 * Табличка 8.2.1 «Зона действия»: протяжённость между двумя стрелками. По изображению 8.2.1
 * ГОСТ Р 52290-2024: стрелки занимают 0,06–0,2 и 0,8–0,94 ширины, надпись «100 м» — 0,24–0,74
 * ширины, цифры — 0,32 высоты, базовая линия на 0,66 высоты. Шаблон пишет целые метры; дробная
 * часть в коде, введённом вручную, выводится через запятую.
 */
const zone = computed(() => {
  const value = ZONE_PLATE.exec(props.node.code)?.[1]
  if (!value) return null
  const { x, y, w, h } = props.node
  const text = `${value.replace('.', ',')} м`
  const arrow = (left: number) => {
    const cx = x + w * left
    const shaft = w * 0.028
    const head = w * 0.07
    return [
      [cx, y + h * 0.26],
      [cx + head, y + h * 0.47],
      [cx + shaft, y + h * 0.47],
      [cx + shaft, y + h * 0.74],
      [cx - shaft, y + h * 0.74],
      [cx - shaft, y + h * 0.47],
      [cx - head, y + h * 0.47],
    ]
      .map((point) => point.join(','))
      .join(' ')
  }
  return {
    text,
    x,
    y,
    w,
    h,
    textX: x + w * 0.492,
    baseline: y + h * 0.662,
    fontSize: (h * 0.32) / 0.72,
    textLength: Math.min(0.52, (0.5 * text.length) / 5) * w,
    arrows: [arrow(0.132), arrow(0.862)],
  }
})
</script>

<template>
  <image
    v-if="href"
    :href="href"
    :x="node.x"
    :y="node.y"
    :width="node.w"
    :height="node.h"
    preserveAspectRatio="xMidYMid meet"
    :data-sign-code="node.code"
    @error="emit('error', node.code)"
  />
  <g v-else-if="speed" :data-drawn-sign="node.code">
    <template v-if="baseHref">
      <image
        :href="baseHref"
        :x="node.x"
        :y="node.y"
        :width="node.w"
        :height="node.h"
        preserveAspectRatio="xMidYMid meet"
        :data-sign-base="baseCode"
        @error="emit('error', baseCode)"
      />
      <circle :cx="speed.cx" :cy="speed.cy" :r="speed.cover" :fill="speed.fill" />
    </template>
    <template v-else>
      <!-- Без изображения стандарта: кайма, кольцо и фон в пропорциях ГОСТ Р 52290. -->
      <circle :cx="speed.cx" :cy="speed.cy" :r="speed.ring * 0.98" :fill="WHITE" />
      <circle :cx="speed.cx" :cy="speed.cy" :r="speed.ring * 0.93" fill="#e32726" />
      <circle :cx="speed.cx" :cy="speed.cy" :r="speed.ring * 0.76" :fill="speed.fill" />
    </template>
    <text
      :x="speed.textX"
      :y="speed.baseline"
      :font-size="speed.fontSize"
      :textLength="speed.textLength"
      lengthAdjust="spacingAndGlyphs"
      :font-family="FONT"
      font-weight="600"
      text-anchor="middle"
      fill="#1d1d1b"
      >{{ speed.value }}</text
    >
  </g>
  <g v-else-if="plate" :data-drawn-sign="node.code">
    <template v-if="baseHref">
      <image
        :href="baseHref"
        :x="plate.x"
        :y="plate.y"
        :width="plate.w"
        :height="plate.h"
        preserveAspectRatio="none"
        :data-sign-base="baseCode"
        @error="emit('error', baseCode)"
      />
      <rect
        :x="plate.x + plate.w * 0.035"
        :y="plate.y + plate.h * 0.07"
        :width="plate.w * 0.93"
        :height="plate.h * 0.86"
        :fill="WHITE"
      />
    </template>
    <rect
      v-else
      :x="plate.x + 1"
      :y="plate.y + 1"
      :width="plate.w - 2"
      :height="plate.h - 2"
      :rx="plate.h * 0.08"
      :fill="WHITE"
      stroke="#1d1d1b"
      :stroke-width="plate.h * 0.03"
    />
    <text
      :x="plate.x + plate.w / 2"
      :y="plate.baseline"
      :font-size="plate.fontSize"
      :textLength="plate.textLength"
      lengthAdjust="spacingAndGlyphs"
      :font-family="FONT"
      font-weight="600"
      text-anchor="middle"
      fill="#1d1d1b"
      >{{ plate.text }}</text
    >
  </g>
  <g v-else-if="zone" :data-drawn-sign="node.code">
    <template v-if="baseHref">
      <image
        :href="baseHref"
        :x="zone.x"
        :y="zone.y"
        :width="zone.w"
        :height="zone.h"
        preserveAspectRatio="none"
        :data-sign-base="baseCode"
        @error="emit('error', baseCode)"
      />
      <!-- Закрывается только надпись между стрелками стандарта. -->
      <rect
        :x="zone.x + zone.w * 0.215"
        :y="zone.y + zone.h * 0.2"
        :width="zone.w * 0.565"
        :height="zone.h * 0.6"
        :fill="WHITE"
      />
    </template>
    <template v-else>
      <rect
        :x="zone.x + 1"
        :y="zone.y + 1"
        :width="zone.w - 2"
        :height="zone.h - 2"
        :rx="zone.h * 0.08"
        :fill="WHITE"
        stroke="#1d1d1b"
        :stroke-width="zone.h * 0.03"
      />
      <polygon
        v-for="(points, index) in zone.arrows"
        :key="index"
        :points="points"
        fill="#1d1d1b"
      />
    </template>
    <text
      :x="zone.textX"
      :y="zone.baseline"
      :font-size="zone.fontSize"
      :textLength="zone.textLength"
      lengthAdjust="spacingAndGlyphs"
      :font-family="FONT"
      font-weight="600"
      text-anchor="middle"
      fill="#1d1d1b"
      >{{ zone.text }}</text
    >
  </g>
  <g v-else :data-missing-sign="node.code">
    <rect
      :x="node.x"
      :y="node.y"
      :width="node.w"
      :height="node.h"
      fill="#fff"
      stroke="#9b2934"
      stroke-width="1.5"
      stroke-dasharray="4 3"
    />
    <text
      :x="node.x + node.w / 2"
      :y="node.y + node.h / 2 + 4"
      font-size="10"
      text-anchor="middle"
      fill="#9b2934"
      >{{ node.code }}</text
    >
  </g>
</template>
