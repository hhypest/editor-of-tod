<script setup lang="ts">
import type { NormativeMark } from '../domain/normative-defaults'

/** Пометка под полем: значение по нормативу, изменено составителем или не указано. */
defineProps<{ mark?: NormativeMark | undefined }>()
const emit = defineEmits<{ restore: [mark: NormativeMark] }>()
</script>

<template>
  <span v-if="mark" class="mark" :class="mark.state" :title="mark.source">
    <template v-if="mark.state === 'normative'">✓ по нормативу</template>
    <template v-else>
      {{ mark.state === 'changed' ? 'Изменено' : 'Не указано' }} · норматив
      {{ mark.normative }}
      <button type="button" class="link" @click.prevent="emit('restore', mark)">
        {{ mark.state === 'changed' ? 'Вернуть' : 'Подставить' }}
      </button>
    </template>
  </span>
</template>

<style scoped>
.mark {
  display: block;
  margin-top: 0.25rem;
  font-size: 0.8rem;
  font-weight: 400;
  line-height: 1.35;
}
.normative {
  color: #2f6b4f;
}
.changed {
  color: #8a4b00;
}
.empty {
  color: #a22030;
}
.link {
  padding: 0;
  border: 0;
  background: none;
  color: #185ca5;
  cursor: pointer;
  font: inherit;
  text-decoration: underline;
}
.link:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}
</style>
