<script setup lang="ts">
import { computed } from 'vue'
import type { SheetNode } from '../domain/sheet-drawing'

const props = defineProps<{
  node: Extract<SheetNode, { t: 'sign' }>
  /** Адрес PNG из локального каталога; null — изображения нет. */
  href: string | null
}>()
const emit = defineEmits<{ error: [code: string] }>()

/** Знак 3.24 без PNG: красная кайма, белый или жёлтый фон, значение скорости. */
const speed = computed(() => {
  const match = /^3\.24(?:_(\d+))?(_ж)?$/.exec(props.node.code)
  if (!match) return null
  return { value: match[1] ?? '50', yellow: Boolean(match[2]) }
})
/** Табличка 8.1.1 без PNG: расстояние до объекта. */
const plate = computed(() => /^8\.1\.1_(\d+)$/.exec(props.node.code)?.[1] ?? null)
const radius = computed(() => Math.min(props.node.w, props.node.h) / 2)
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
    <circle
      :cx="node.x + node.w / 2"
      :cy="node.y + node.h / 2"
      :r="radius * 0.9"
      :fill="speed.yellow ? '#ffd200' : '#fff'"
      stroke="#e30613"
      :stroke-width="radius * 0.2"
    />
    <circle
      :cx="node.x + node.w / 2"
      :cy="node.y + node.h / 2"
      :r="radius"
      fill="none"
      stroke="#fff"
      :stroke-width="radius * 0.04"
    />
    <text
      :x="node.x + node.w / 2"
      :y="node.y + node.h / 2 + radius * 0.34"
      :font-size="radius * (speed.value.length > 2 ? 0.8 : 1)"
      font-weight="bold"
      text-anchor="middle"
      fill="#000"
      >{{ speed.value }}</text
    >
  </g>
  <g v-else-if="plate" :data-drawn-sign="node.code">
    <rect
      :x="node.x + 0.8"
      :y="node.y + 0.8"
      :width="node.w - 1.6"
      :height="node.h - 1.6"
      :rx="node.h * 0.12"
      :fill="'#fff'"
      stroke="#000"
      stroke-width="1.6"
    />
    <text
      :x="node.x + node.w / 2"
      :y="node.y + node.h / 2 + node.h * 0.2"
      :font-size="node.h * 0.56"
      font-weight="bold"
      text-anchor="middle"
      >{{ plate }} м</text
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
