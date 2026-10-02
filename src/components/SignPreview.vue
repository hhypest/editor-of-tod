<script setup lang="ts">
import { signImageUrl } from '../services/sign-image-url'
import { computed } from 'vue'
import { drawableWithoutImage, drawnSignBase, signImageCode } from '../domain/sheet-drawing'
import SheetSign from './SheetSign.vue'

/**
 * Знак в рабочей области и в свойствах объекта: PNG из каталога, знак, дорисованный поверх
 * изображения стандарта (3.24 с числом, 8.1.1 с расстоянием), или код, если изображения нет.
 */
const props = defineProps<{
  code: string
  /** Коды, для которых в каталоге (или в закреплённых редакциях) есть PNG. */
  known: ReadonlySet<string>
  revisions?: Readonly<Record<string, number>>
  height: number
}>()

function url(code: string): string | null {
  if (!props.known.has(code)) return null
  const revision = props.revisions?.[code]
  return signImageUrl(code, revision)
}

const view = computed(() => {
  const image = url(signImageCode(props.code, props.known))
  if (image) return { kind: 'image' as const, url: image }
  if (!drawableWithoutImage(props.code)) return { kind: 'code' as const }
  const base = drawnSignBase(props.code)
  // Пропорции таблички 8.1.1 по ГОСТ Р 52290-2024 — примерно 2 : 1.
  const plate = props.code.startsWith('8.')
  const h = plate ? props.height * 0.62 : props.height
  return {
    kind: 'drawn' as const,
    w: plate ? h * 1.96 : h,
    h,
    base: base ? url(base) : null,
  }
})
</script>

<template>
  <img v-if="view.kind === 'image'" :src="view.url" :alt="`Знак ${code}`" draggable="false" />
  <svg
    v-else-if="view.kind === 'drawn'"
    class="drawn-sign"
    :width="view.w"
    :height="view.h"
    :viewBox="`0 0 ${view.w} ${view.h}`"
    role="img"
    :aria-label="`Знак ${code}`"
    :data-drawn-preview="code"
  >
    <SheetSign
      :node="{ t: 'sign', x: 0, y: 0, w: view.w, h: view.h, code }"
      :href="null"
      :base-href="view.base"
    />
  </svg>
  <span v-else class="code-only">{{ code }}</span>
</template>
