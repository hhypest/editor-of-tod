<script setup lang="ts">
import { ref, watch } from 'vue'
import {
  applySchemeDetails,
  createSchemeDetailsDraft,
  SchemeEditError,
} from '../domain/edit-details'
import type { Scheme } from '../domain/model'

const props = defineProps<{ scheme: Scheme }>()
const emit = defineEmits<{ apply: [scheme: Scheme]; dirty: [value: boolean] }>()
const draft = ref(createSchemeDetailsDraft(props.scheme))
const dirty = ref(false)
const error = ref('')
const status = ref('')
const zoneCodes = ['b33', 'b34'] as const

watch(
  () => props.scheme,
  (scheme) => {
    draft.value = createSchemeDetailsDraft(scheme)
    dirty.value = false
    emit('dirty', false)
  },
)

function markDirty(): void {
  error.value = ''
  status.value = ''
  if (!dirty.value) {
    dirty.value = true
    emit('dirty', true)
  }
}

function discard(): void {
  draft.value = createSchemeDetailsDraft(props.scheme)
  dirty.value = false
  error.value = ''
  status.value = ''
  emit('dirty', false)
}

function applyDraft(): void {
  try {
    const updated = applySchemeDetails(props.scheme, draft.value)
    dirty.value = false
    error.value = ''
    status.value = 'Правки применены к проекту. Скачайте копию v2, чтобы сохранить их в файле.'
    emit('apply', updated)
    emit('dirty', false)
  } catch (cause) {
    error.value = cause instanceof SchemeEditError ? cause.message : 'Не удалось применить правки.'
  }
}
</script>

<template>
  <section aria-labelledby="details-title">
    <h2 id="details-title">Параметры и реквизиты проекта</h2>
    <p class="hint">
      Изменения применяются только к открытой копии проекта. Расстояния вводятся в метрах, скорости
      — в км/ч. Изменение параметров не переставляет знаки и не проверяет соответствие схемы нормам.
    </p>
    <form @submit.prevent="applyDraft" @input="markDirty" @change="markDirty">
      <fieldset>
        <legend>Параметры схемы</legend>
        <div class="fields">
          <label>Участок <input v-model="draft.parameters.locationText" type="text" /></label>
          <label
            >Направление слева <input v-model="draft.parameters.directions.left" type="text"
          /></label>
          <label
            >Направление справа <input v-model="draft.parameters.directions.right" type="text"
          /></label>
        </div>
        <h3>Расстояния до знаков, м</h3>
        <p class="hint">
          Неизвестное расстояние оставьте пустым. Допускается дробная часть через запятую или точку.
        </p>
        <div class="fields compact">
          <label
            >d300
            <input
              v-model="draft.parameters.signDistancesMetres.d300"
              type="text"
              inputmode="decimal"
          /></label>
          <label
            >d250
            <input
              v-model="draft.parameters.signDistancesMetres.d250"
              type="text"
              inputmode="decimal"
          /></label>
          <label
            >d150
            <input
              v-model="draft.parameters.signDistancesMetres.d150"
              type="text"
              inputmode="decimal"
          /></label>
          <label
            >d50
            <input
              v-model="draft.parameters.signDistancesMetres.d50"
              type="text"
              inputmode="decimal"
          /></label>
        </div>
        <h3>Ступени скорости, км/ч</h3>
        <div class="fields compact">
          <label
            >Первая
            <input v-model="draft.parameters.speedStagesKmh[0]" type="text" inputmode="decimal"
          /></label>
          <label
            >Вторая
            <input v-model="draft.parameters.speedStagesKmh[1]" type="text" inputmode="decimal"
          /></label>
          <label
            >Третья
            <input v-model="draft.parameters.speedStagesKmh[2]" type="text" inputmode="decimal"
          /></label>
        </div>
        <label class="checkbox">
          <input v-model="draft.parameters.yellowTemporarySigns" type="checkbox" />
          Жёлтый фон временных знаков
        </label>
        <div v-for="code in zoneCodes" :key="code">
          <h3>Зона {{ code.toUpperCase() }}</h3>
          <div class="fields compact">
            <label
              >Отвод, м
              <input
                v-model="draft.parameters.workZones[code].taperMetres"
                type="text"
                inputmode="decimal"
            /></label>
            <label
              >Буфер, м
              <input
                v-model="draft.parameters.workZones[code].bufferMetres"
                type="text"
                inputmode="decimal"
            /></label>
            <label
              >Фронт работ, м
              <input
                v-model="draft.parameters.workZones[code].workMetres"
                type="text"
                inputmode="decimal"
            /></label>
            <label
              >Подпись отвода
              <input v-model="draft.parameters.workZones[code].labels.taper" type="text"
            /></label>
            <label
              >Подпись буфера
              <input v-model="draft.parameters.workZones[code].labels.buffer" type="text"
            /></label>
            <label
              >Подпись фронта
              <input v-model="draft.parameters.workZones[code].labels.work" type="text"
            /></label>
          </div>
        </div>
      </fieldset>

      <fieldset>
        <legend>Реквизиты листа</legend>
        <h3>Разработчик</h3>
        <div class="fields">
          <label
            >Организация <input v-model="draft.titleBlock.developer.organization" type="text"
          /></label>
          <label>ФИО <input v-model="draft.titleBlock.developer.name" type="text" /></label>
          <label>Дата <input v-model="draft.titleBlock.developer.date" type="text" /></label>
        </div>
        <h3>Работы</h3>
        <div class="fields">
          <label
            >Организация <input v-model="draft.titleBlock.work.organization" type="text"
          /></label>
          <label>Описание <input v-model="draft.titleBlock.work.description" type="text" /></label>
          <label>Период <input v-model="draft.titleBlock.work.period" type="text" /></label>
          <label
            >Ответственный 1 <input v-model="draft.titleBlock.responsible[0]" type="text"
          /></label>
          <label
            >Ответственный 2 <input v-model="draft.titleBlock.responsible[1]" type="text"
          /></label>
        </div>
        <h3>Утверждение</h3>
        <div class="fields">
          <label
            >Должность <input v-model="draft.titleBlock.approver.position" type="text"
          /></label>
          <label
            >Организация <input v-model="draft.titleBlock.approver.organization" type="text"
          /></label>
          <label>ФИО <input v-model="draft.titleBlock.approver.name" type="text" /></label>
        </div>
        <h3>Согласование</h3>
        <div class="fields">
          <label
            >Должность <input v-model="draft.titleBlock.agreement.position" type="text"
          /></label>
          <label>ФИО <input v-model="draft.titleBlock.agreement.name" type="text" /></label>
          <label>Год <input v-model="draft.titleBlock.agreement.year" type="text" /></label>
        </div>
      </fieldset>

      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <p v-if="status" class="hint" role="status">{{ status }}</p>
      <div class="actions">
        <button type="submit" class="primary" :disabled="!dirty">Применить правки</button>
        <button type="button" :disabled="!dirty" @click="discard">Отменить ввод</button>
      </div>
    </form>
  </section>
</template>

<style scoped>
h2 {
  margin: 0 0 1rem;
  font-size: 1.4rem;
}
h3 {
  margin: 1.2rem 0 0.5rem;
  font-size: 1rem;
}
.hint {
  color: #526273;
  font-size: 0.9rem;
  line-height: 1.5;
}
.error {
  color: #a22030;
  font-weight: 600;
}
fieldset {
  margin: 1.5rem 0;
  padding: 1rem;
  border: 1px solid #d8e1eb;
  border-radius: 0.45rem;
}
legend {
  padding: 0 0.4rem;
  font-weight: 700;
}
.fields {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr));
  gap: 0.8rem 1rem;
}
.fields.compact {
  grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr));
}
label {
  display: block;
  font-size: 0.9rem;
  font-weight: 600;
}
input[type='text'] {
  display: block;
  width: 100%;
  box-sizing: border-box;
  margin-top: 0.3rem;
  padding: 0.55rem;
  border: 1px solid #93a5b8;
  border-radius: 0.35rem;
  font: inherit;
}
.checkbox {
  margin: 1rem 0;
}
.actions {
  display: flex;
  gap: 0.7rem;
  flex-wrap: wrap;
}
button {
  padding: 0.7rem 1rem;
  border: 1px solid #185ca5;
  border-radius: 0.45rem;
  background: #fff;
  color: #185ca5;
  cursor: pointer;
  font: inherit;
  font-weight: 600;
}
button.primary {
  background: #185ca5;
  color: #fff;
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
