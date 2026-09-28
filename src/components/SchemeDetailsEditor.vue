<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import {
  applySchemeDetails,
  createSchemeDetailsDraft,
  SchemeEditError,
} from '../domain/edit-details'
import type { Scheme } from '../domain/model'

const props = defineProps<{
  scheme: Scheme
  locked?: boolean
  mode?: 'source' | 'geometry' | 'title'
}>()
const emit = defineEmits<{ apply: [scheme: Scheme]; dirty: [value: boolean] }>()
const heading = computed(() => {
  if (props.mode === 'source') return 'Место работ и направления'
  if (props.mode === 'geometry') return 'Размеры и параметры схемы'
  if (props.mode === 'title') return 'Реквизиты листа и согласования'
  return 'Параметры и реквизиты проекта'
})
const draft = ref(createSchemeDetailsDraft(props.scheme))
const dirty = ref(false)
const error = ref('')
const status = ref('')
const zoneCodes = ['b33', 'b34'] as const

function addZone(code: 'b33' | 'b34'): void {
  if (props.locked || draft.value.parameters.workZones[code]) return
  draft.value.parameters.workZones[code] = {
    taperMetres: '',
    bufferMetres: '',
    workMetres: '',
    labels: { taper: '', buffer: '', work: '' },
  }
  markDirty()
}

watch(
  () => props.scheme,
  (scheme) => {
    draft.value = createSchemeDetailsDraft(scheme)
    dirty.value = false
    emit('dirty', false)
  },
)

function markDirty(): void {
  if (props.locked) return
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
  if (props.locked) return
  try {
    const updated = applySchemeDetails(props.scheme, draft.value)
    dirty.value = false
    error.value = ''
    status.value = 'Правки применены к проекту. Сохраните черновик или скачайте копию v5.'
    emit('apply', updated)
    emit('dirty', false)
  } catch (cause) {
    error.value = cause instanceof SchemeEditError ? cause.message : 'Не удалось применить правки.'
  }
}
</script>

<template>
  <section aria-labelledby="details-title">
    <h2 id="details-title">{{ heading }}</h2>
    <p class="hint">
      Изменения применяются к открытой копии проекта после нажатия «Применить правки». Они не
      переставляют знаки и не подтверждают соответствие схемы нормам.
    </p>
    <form @submit.prevent="applyDraft" @input="markDirty" @change="markDirty">
      <fieldset v-if="!mode || mode === 'source'" :disabled="locked">
        <legend>Место работ</legend>
        <div class="fields">
          <label>Участок <input v-model="draft.parameters.locationText" type="text" /></label>
          <label
            >Направление слева <input v-model="draft.parameters.directions.left" type="text"
          /></label>
          <label
            >Направление справа <input v-model="draft.parameters.directions.right" type="text"
          /></label>
        </div>
      </fieldset>
      <fieldset v-if="!mode || mode === 'geometry'" :disabled="locked">
        <legend>Параметры схемы</legend>
        <p class="hint">
          Расстояния вводятся в метрах, скорости — в км/ч. Для созданного в редакторе проекта
          изменение фронта через границу 30 м требует нового проекта с другим вариантом.
        </p>
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
          <label
            >n100
            <input
              v-model="draft.parameters.signDistancesMetres.n100"
              type="text"
              inputmode="decimal"
          /></label>
          <label
            >n50
            <input
              v-model="draft.parameters.signDistancesMetres.n50"
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
        <h3>Условия и решение составителя</h3>
        <div class="fields compact">
          <label
            >Местоположение
            <select v-model="draft.parameters.location">
              <option value="auto">Не определено</option>
              <option value="in">В населённом пункте</option>
              <option value="out">Вне населённого пункта</option>
            </select>
          </label>
          <label
            >Типоразмер знаков
            <select v-model="draft.parameters.signSize">
              <option value="auto">Уточнить</option>
              <option value="I">I</option>
              <option value="II">II</option>
              <option value="III">III</option>
            </select>
          </label>
          <label
            >Скорость в населённом пункте, км/ч
            <input v-model="draft.parameters.settlementSpeedKmh" inputmode="decimal" type="text" />
          </label>
          <label
            >Фронт
            <select v-model="draft.parameters.frontStyle">
              <option value="part">Частичный</option>
              <option value="solid">Сплошной</option>
            </select>
          </label>
          <label
            >Регулирование Б.34
            <select v-model="draft.parameters.regulation.mode">
              <option value="auto">Решение не принято</option>
              <option value="signs">Знаки приоритета</option>
              <option value="one">Один регулировщик</option>
              <option value="two">Два регулировщика</option>
            </select>
          </label>
          <label
            >Интенсивность, авт./ч (по данным составителя)
            <input v-model="draft.parameters.regulation.hourly" type="text" />
          </label>
        </div>
        <label class="checkbox"
          ><input v-model="draft.parameters.frontFromPu66" type="checkbox" />
          Фронт взят из ПУ-66 (проверьте размер на месте)
        </label>
        <label class="checkbox"
          ><input v-model="draft.parameters.regulation.vis" type="checkbox" />
          Видимость ограничена
        </label>
        <label class="checkbox"
          ><input v-model="draft.parameters.regulation.straight" type="checkbox" />
          Прямой участок дороги
        </label>
        <div v-for="code in zoneCodes" :key="code">
          <h3>Зона {{ code.toUpperCase() }}</h3>
          <button
            v-if="!draft.parameters.workZones[code]"
            type="button"
            :disabled="locked"
            @click="addZone(code)"
          >
            Добавить размеры {{ code.toUpperCase() }}
          </button>
          <div v-else class="fields compact">
            <label
              >Отвод, м
              <input
                v-model="draft.parameters.workZones[code]!.taperMetres"
                type="text"
                inputmode="decimal"
            /></label>
            <label
              >Буфер, м
              <input
                v-model="draft.parameters.workZones[code]!.bufferMetres"
                type="text"
                inputmode="decimal"
            /></label>
            <label
              >Фронт работ, м
              <input
                v-model="draft.parameters.workZones[code]!.workMetres"
                type="text"
                inputmode="decimal"
            /></label>
            <label
              >Подпись отвода
              <input v-model="draft.parameters.workZones[code]!.labels.taper" type="text"
            /></label>
            <label
              >Подпись буфера
              <input v-model="draft.parameters.workZones[code]!.labels.buffer" type="text"
            /></label>
            <label
              >Подпись фронта
              <input v-model="draft.parameters.workZones[code]!.labels.work" type="text"
            /></label>
          </div>
        </div>
      </fieldset>

      <fieldset v-if="!mode || mode === 'title'" :disabled="locked">
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
        <h3>Утверждает владелец автомобильной дороги</h3>
        <div class="fields">
          <label
            >Должность <input v-model="draft.titleBlock.approver.position" type="text"
          /></label>
          <label
            >Владелец дороги / организация
            <input v-model="draft.titleBlock.approver.organization" type="text"
          /></label>
          <label>ФИО <input v-model="draft.titleBlock.approver.name" type="text" /></label>
        </div>
        <h3>Согласовывает Госавтоинспекция</h3>
        <div class="fields">
          <label
            >Должность и подразделение
            <input v-model="draft.titleBlock.agreement.position" type="text"
          /></label>
          <label>ФИО <input v-model="draft.titleBlock.agreement.name" type="text" /></label>
          <label>Год <input v-model="draft.titleBlock.agreement.year" type="text" /></label>
        </div>
      </fieldset>

      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <p v-if="status" class="hint" role="status">{{ status }}</p>
      <div class="actions">
        <button type="submit" class="primary" :disabled="locked || !dirty">Применить правки</button>
        <button type="button" :disabled="locked || !dirty" @click="discard">Отменить ввод</button>
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
