<script setup lang="ts">
import type { Scheme } from '../domain/model'
defineProps<{ exclusions: Scheme['roadObjectExclusions']; locked: boolean }>()
const emit = defineEmits<{ restore: [id: number] }>()
</script>

<template>
  <section v-if="exclusions?.objects.length" class="excluded-posts" data-excluded-road-posts>
    <h3>Исключённые стойки примыканий</h3>
    <p>
      Эти стойки сохранены в проекте вместе со знаками, замером и связью, но не рисуются на листе.
      Восстановление возвращает сохранённые данные. Положение на ветви учитывает текущее положение
      её узла; автоматический пересчёт не выполняется.
    </p>
    <ul>
      <li v-for="item in exclusions.objects" :key="item.post.id" :data-excluded-post="item.post.id">
        <span
          >Стойка № {{ item.post.id }} — узел № {{ item.link.nodeId }}:
          {{ item.post.signIds.join(', ') }}</span
        >
        <button type="button" :disabled="locked" @click="emit('restore', item.post.id)">
          Восстановить стойку № {{ item.post.id }}
        </button>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.excluded-posts {
  border-top: 1px solid #c8d1df;
  margin-top: 1rem;
  padding-top: 1rem;
}
h3 {
  font-size: 1.05rem;
}
p {
  color: #526273;
  line-height: 1.5;
}
ul {
  padding-left: 1.2rem;
}
li {
  margin: 0.7rem 0;
}
span {
  display: block;
  margin-bottom: 0.4rem;
}
button {
  font: inherit;
  padding: 0.45rem 0.7rem;
  cursor: pointer;
}
button:disabled {
  cursor: default;
}
:focus-visible {
  outline: 3px solid #185ca5;
  outline-offset: 2px;
}
</style>
