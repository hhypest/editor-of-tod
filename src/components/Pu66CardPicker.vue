<script setup lang="ts">
import { computed, ref } from 'vue'
import { searchPu66Cards } from '../domain/pu66-search'
import type { Pu66ListEntry } from '../services/local-pu66'

const props = defineProps<{
  cards: readonly Pu66ListEntry[]
  disabled?: boolean
  idPrefix: string
}>()
const selected = defineModel<string>({ required: true })
const emit = defineEmits<{ choose: [key: string] }>()
const query = ref('')

const found = computed(() => searchPu66Cards(props.cards, query.value))
/** Выбранная запись остаётся в списке, даже если новый запрос её не находит. */
const options = computed(() => {
  const current = props.cards.find((card) => card.referenceId === selected.value)
  return current && !found.value.includes(current) ? [current, ...found.value] : found.value
})

function place(card: Pu66ListEntry): string {
  return [card.section || (card.station ? `ст. ${card.station}` : ''), card.location]
    .filter(Boolean)
    .join(', ')
}

function onChange(event: Event): void {
  // Значение модели родителя обновится только при следующей отрисовке, поэтому берём его из поля.
  emit('choose', (event.target as HTMLSelectElement).value)
}
</script>

<template>
  <div class="picker">
    <label :for="`${idPrefix}-search`">
      Поиск карточки
      <input
        :id="`${idPrefix}-search`"
        v-model="query"
        type="search"
        autocomplete="off"
        placeholder="км и пикет (53 км 2 пк, 53/2), станция, участок или дорога"
        :disabled="disabled"
      />
    </label>
    <p class="hint" role="status" aria-live="polite">
      {{
        query.trim()
          ? `Найдено: ${found.length} из ${cards.length}.`
          : `Карточек в реестре: ${cards.length}.`
      }}
    </p>
    <label :for="`${idPrefix}-choice`">
      Локальная карточка
      <select
        :id="`${idPrefix}-choice`"
        v-model="selected"
        :disabled="disabled || !cards.length"
        @change="onChange"
      >
        <option value="">Выберите запись</option>
        <option v-for="card in options" :key="card.referenceId" :value="card.referenceId">
          {{ place(card) }} · {{ card.roadName || 'дорога не указана' }} · редакция №
          {{ card.revision }}
        </option>
      </select>
    </label>
  </div>
</template>

<style scoped>
.picker {
  display: grid;
  gap: 0.4rem;
  max-width: 44rem;
}
label {
  font-weight: 600;
}
input,
select {
  display: block;
  width: 100%;
  box-sizing: border-box;
  padding: 0.6rem;
  margin-top: 0.3rem;
  border: 1px solid #93a5b8;
  border-radius: 0.35rem;
  font: inherit;
}
.hint {
  margin: 0;
  color: #526273;
  font-size: 0.9rem;
}
</style>
