<script setup lang="ts">
import { computed, ref } from 'vue'
import { selectTemplateByWorkFront } from '../domain/registry'

const lengthText = ref('')
const suggestion = computed(() => {
  if (!lengthText.value.trim()) return null
  const value = Number(lengthText.value.trim().replace(',', '.'))
  if (!Number.isFinite(value) || value <= 0) return null
  return selectTemplateByWorkFront(value)
})
</script>

<template>
  <section class="choice" aria-labelledby="choice-title">
    <h2 id="choice-title">Предварительный выбор варианта</h2>
    <label for="front-length">Длина фронта работ, м</label>
    <input
      id="front-length"
      v-model="lengthText"
      type="text"
      inputmode="decimal"
      placeholder="Например, 30"
    />
    <p v-if="lengthText && !suggestion" role="alert">Укажите положительное число в метрах.</p>
    <p v-if="suggestion" role="status">
      По принятому правилу проекта: <strong>{{ suggestion.code.toUpperCase() }}</strong
      >.
      <span v-if="suggestion.boundaryNeedsReview"
        >При ровно 30 м выбран Б.33 по подтверждённому правилу проекта; подписи и размерные
        обозначения ОДМ различаются. Применимость остальных элементов схемы проверьте
        отдельно.</span
      >
    </p>
    <p class="hint">
      Показан только выбор по длине: условия пропуска транспорта, видимость, интенсивность и
      применимость схемы здесь не проверяются. Знаки не расставляются автоматически.
    </p>
  </section>
</template>

<style scoped>
.choice {
  margin: 1rem 0;
  padding: 2rem;
  background: #fff;
  border: 1px solid #d8e1eb;
  border-radius: 0.8rem;
}
h2 {
  margin-top: 0;
}
label {
  display: block;
  margin-bottom: 0.5rem;
  font-weight: 600;
}
input {
  padding: 0.6rem;
  border: 1px solid #93a5b8;
  border-radius: 0.35rem;
  font: inherit;
  max-width: 18rem;
  width: 100%;
  box-sizing: border-box;
}
.hint {
  color: #526273;
  line-height: 1.5;
}
</style>
