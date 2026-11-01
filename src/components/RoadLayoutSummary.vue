<script setup lang="ts">
import { computed, useId } from 'vue'
import { decimalComma } from '../domain/number-format'
import type { RoadLayout } from '../domain/road-layout'

const props = defineProps<{ layout: RoadLayout; editable?: boolean; locked?: boolean }>()
const emit = defineEmits<{ select: [id: number] }>()
const titleId = useId()
const linkedCounts = computed(() => {
  const counts = new Map<number, number>()
  for (const link of props.layout.links) counts.set(link.nodeId, (counts.get(link.nodeId) ?? 0) + 1)
  return counts
})
</script>

<template>
  <section
    v-if="layout.nodes.length"
    class="road-summary"
    :aria-labelledby="titleId"
    data-test="road-layout-summary"
  >
    <h3 :id="titleId">Примыкания: сохранённые данные</h3>
    <p>
      Ветви показаны на условном рисунке. Автоматика знаков ещё разрабатывается; автоматическая
      перестройка и выпуск этой схемы недоступны. Данные сохраняются вместе с проектом.
    </p>
    <div class="table-scroll">
      <table>
        <thead>
          <tr>
            <th>Вид и название</th>
            <th>Подход и сторона</th>
            <th>Расстояние до оси узла</th>
            <th>Связанные объекты</th>
            <th v-if="editable">Действия</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="node in layout.nodes" :key="node.id">
            <td v-if="node.kind === 'junction'">
              {{ node.roadKind === 'road' ? 'Дорога' : 'Выезд' }}: {{ node.name || 'без названия' }}
            </td>
            <td v-else>
              Конечный Т-перекрёсток: {{ node.branchNames.up || 'верхняя ветвь без названия' }} /
              {{ node.branchNames.down || 'нижняя ветвь без названия' }}
            </td>
            <td>
              {{ node.position.approach === 'left' ? 'Левый' : 'Правый' }} подход<template
                v-if="node.kind === 'junction'"
                >, {{ node.side === 'up' ? 'сверху' : 'снизу' }}</template
              >
            </td>
            <td>{{ decimalComma(node.position.metres) }} м от {{ node.position.from }}</td>
            <td>{{ linkedCounts.get(node.id) ?? 0 }}</td>
            <td v-if="editable">
              <button
                type="button"
                :aria-label="`Изменить узел №${node.id}`"
                :disabled="locked"
                @click="emit('select', node.id)"
              >
                Изменить
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <p>
      L0 и E — точки отсчёта своего подхода. Это расстояние до оси примыкания, отдельно от
      расстояния установки стойки и числа на табличке. Положение на рисунке не задаёт метры.
    </p>
  </section>
</template>

<style scoped>
.road-summary {
  margin: 1rem 0;
  padding: 1rem;
  border: 1px solid #c8d1df;
  border-radius: 0.5rem;
}
h3 {
  margin: 0 0 0.6rem;
  font-size: 1.05rem;
}
p {
  font-size: 0.9rem;
  line-height: 1.5;
}
.table-scroll {
  overflow-x: auto;
}
table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.9rem;
}
th,
td {
  padding: 0.5rem;
  text-align: left;
  vertical-align: top;
  border: 1px solid #c8d1df;
}
button {
  padding: 0.55rem 0.7rem;
  border: 1px solid #185ca5;
  border-radius: 0.4rem;
  background: #fff;
  color: #185ca5;
  cursor: pointer;
  font: inherit;
}
button:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}
button:not(:disabled):focus-visible {
  outline: 2px solid #185ca5;
  outline-offset: 2px;
}
</style>
