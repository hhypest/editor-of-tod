<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { pddRoads, pddVehicles, pddSpeedReference } from '../domain/pdd-speed'
import type { NormativeRules } from '../domain/normative-parameters'

const props = defineProps<{
  location: 'in' | 'out' | 'auto' | ''
  rules: NormativeRules
  locked?: boolean
}>()
const emit = defineEmits<{ apply: [speed: number] }>()
const road = ref<keyof typeof pddRoads | ''>('')
const vehicle = ref<keyof typeof pddVehicles | ''>('')
watch(
  () => props.location,
  () => {
    road.value = ''
    vehicle.value = ''
  },
)
const reference = computed(() =>
  pddSpeedReference(props.location, road.value, vehicle.value, props.rules),
)
</script>

<template>
  <details class="speed-reference">
    <summary>Справочник скорости по ПДД</summary>
    <p class="hint">
      Сверьте вид дороги, состав потока, постоянные знаки и местные ограничения. 90 км/ч вне
      населённого пункта — предварительное значение для легковых, мотоциклов и грузовых до 3,5 т на
      остальных дорогах.
    </p>
    <div class="fields">
      <label
        >Вид дороги для сверки скорости
        <select v-model="road" :disabled="locked">
          <option value="">Выберите условие</option>
          <option v-for="(label, key) in pddRoads" :key="key" :value="key">{{ label }}</option>
        </select>
      </label>
      <label
        >Вид ТС для сверки скорости
        <select v-model="vehicle" :disabled="locked">
          <option value="">Выберите условие</option>
          <option v-for="(label, key) in pddVehicles" :key="key" :value="key">{{ label }}</option>
        </select>
      </label>
    </div>
    <p v-if="vehicle === 'permit'" class="hint">
      Проверьте скорость в специальном разрешении и другие ограничения по пп. 10.1–10.5.
      Автоматического значения для этого условия нет.
    </p>
    <p v-else-if="road && vehicle && !reference" class="hint">
      Условия не согласуются с местоположением. Уточните выбранный вид дороги.
    </p>
    <template v-if="reference">
      <p role="status">
        Предел для выбранных условий: {{ reference.speed }} км/ч. {{ reference.source }}.
        {{
          reference.confirmed
            ? 'Числа подтверждены по библиотеке.'
            : 'Предварительные числа: подтвердите параметры по действующей редакции.'
        }}
      </p>
      <p v-if="!reference.applicable" class="hint">
        Автомагистраль по п. 1.2 ПДД не имеет пересечений с железнодорожными путями в одном уровне.
        Значение показано для справки; подстановка в схему переезда недоступна.
      </p>
      <p class="hint">
        Это предел для выбранного вида ТС. Проверьте скорость всего потока и ступени 3.24;
        подстановка не повышает разрешённую скорость по действующим знакам. В проекте сохраняются
        скорость и ступени; выбранные здесь условия пока служат для справки и проверяются в пункте
        «Скорость по условиям ПДД».
      </p>
      <button
        type="button"
        :disabled="locked || !reference.applicable"
        @click="emit('apply', reference.speed)"
      >
        Подставить скорость для выбранных условий
      </button>
    </template>
  </details>
</template>

<style scoped>
.speed-reference {
  padding: 0.6rem;
  margin: 0.6rem 0;
  border: 1px solid #b8c8da;
  border-radius: 0.3rem;
}
summary {
  cursor: pointer;
  font-weight: 600;
}
.fields {
  display: flex;
  flex-wrap: wrap;
  gap: 0.8rem;
}
label {
  display: grid;
  gap: 0.3rem;
  max-width: 100%;
}
select {
  max-width: 100%;
}
.hint {
  color: #46576c;
  font-size: 0.9rem;
}
</style>
