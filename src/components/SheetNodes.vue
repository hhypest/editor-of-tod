<script setup lang="ts">
import { drawnSignBase, type SheetNode } from '../domain/sheet-drawing'
import SheetSign from './SheetSign.vue'

const props = defineProps<{
  nodes: readonly SheetNode[]
  signUrl: (code: string) => string | null
  /** Префикс идентификаторов defs: на странице одновременно есть лист и его миниатюра. */
  prefix: string
}>()
const emit = defineEmits<{ imageError: [code: string] }>()

function drawnBaseUrl(code: string): string | null {
  const base = drawnSignBase(code)
  return base ? props.signUrl(base) : null
}

function paint(fill: string | undefined): string {
  return fill === 'url(#sheet-hatch)' ? `url(#${props.prefix}-hatch)` : (fill ?? 'none')
}
</script>

<template>
  <g>
    <template v-for="(node, index) in nodes" :key="index">
      <rect
        v-if="node.t === 'rect'"
        :x="node.x"
        :y="node.y"
        :width="Math.max(0, node.w)"
        :height="Math.max(0, node.h)"
        :rx="node.rx"
        :fill="paint(node.fill)"
        :stroke="node.stroke"
        :stroke-width="node.sw"
      />
      <line
        v-else-if="node.t === 'line'"
        :x1="node.x1"
        :y1="node.y1"
        :x2="node.x2"
        :y2="node.y2"
        :stroke="node.stroke ?? '#000'"
        :stroke-width="node.sw ?? 1"
        :stroke-dasharray="node.dash"
        :marker-start="node.arrows ? `url(#${prefix}-arrow)` : undefined"
        :marker-end="node.arrows ? `url(#${prefix}-arrow)` : undefined"
      />
      <path
        v-else-if="node.t === 'path'"
        :d="node.d"
        :fill="node.fill ?? 'none'"
        :stroke="node.stroke"
        :stroke-width="node.sw"
      />
      <text
        v-else-if="node.t === 'text'"
        :class="node.cls"
        :x="node.x"
        :y="node.y"
        :font-size="node.size"
        :font-weight="node.bold ? 'bold' : undefined"
        :font-style="node.italic ? 'italic' : undefined"
        :text-decoration="node.underline ? 'underline' : undefined"
        :text-anchor="node.anchor ?? 'start'"
        :fill="node.fill ?? '#000'"
        :transform="node.rotate ? `rotate(${node.rotate} ${node.x} ${node.y})` : undefined"
        >{{ node.text }}</text
      >
      <SheetSign
        v-else-if="node.t === 'sign'"
        :node="node"
        :href="signUrl(node.code)"
        :base-href="drawnBaseUrl(node.code)"
        @error="emit('imageError', $event)"
      />
      <use
        v-else-if="node.t === 'symbol'"
        :href="`#${prefix}-${node.id}`"
        :x="node.x"
        :y="node.y"
        :width="node.w"
        :height="node.h"
      />
      <g v-else-if="node.t === 'group'" :class="node.cls" :data-object-id="node.objectId">
        <SheetNodes
          :nodes="node.children"
          :sign-url="signUrl"
          :prefix="prefix"
          @image-error="emit('imageError', $event)"
        />
      </g>
    </template>
  </g>
</template>
