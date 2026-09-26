<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { createNewScheme, SchemeCreationError, type NewSchemeInput } from '../domain/create-scheme'
import type { Scheme } from '../domain/model'
import { selectTemplateByWorkFront } from '../domain/registry'

defineProps<{ locked?: boolean }>()
const emit = defineEmits<{ create: [scheme: Scheme] }>()
const input = reactive<NewSchemeInput>({
  referenceId: '',
  locationText: '',
  directionLeft: '',
  directionRight: '',
  frontMetres: '',
  taperMetres: '',
  bufferMetres: '',
  speedStagesKmh: ['', '', ''],
  yellowTemporarySigns: false,
})
const error = ref('')
const choice = computed(() => {
  const value = input.frontMetres.trim().replace(',', '.')
  if (!/^\d+(?:\.\d+)?$/.test(value)) return null
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? selectTemplateByWorkFront(number) : null
})

function create(): void {
  try {
    error.value = ''
    emit('create', createNewScheme(input))
  } catch (cause) {
    error.value =
      cause instanceof SchemeCreationError ? cause.message : 'Не удалось создать проект.'
  }
}
</script>

<template>
  <section aria-labelledby="new-scheme-title">
    <h2 id="new-scheme-title">Новый проект без старого JSON</h2>
    <p class="hint">
      Заполните измеренные размеры и скорости вручную. Идентификатор переезда здесь вводится
      составителем и не считается сверкой с ПУ-66. После создания можно явно закрепить карточку из
      локального реестра, добавить знаки, расстояния и реквизиты. Автоматическая нормативная
      расстановка пока не выполняется.
    </p>
    <form @submit.prevent="create">
      <fieldset :disabled="locked">
        <div class="fields">
          <label
            >Локальный идентификатор переезда
            <input v-model="input.referenceId" type="text" maxlength="120" required />
          </label>
          <label
            >Участок
            <input v-model="input.locationText" type="text" maxlength="5000" />
          </label>
          <label
            >Направление слева
            <input v-model="input.directionLeft" type="text" maxlength="5000" />
          </label>
          <label
            >Направление справа
            <input v-model="input.directionRight" type="text" maxlength="5000" />
          </label>
          <label
            >Фронт работ, м
            <input v-model="input.frontMetres" type="text" inputmode="decimal" required />
          </label>
          <label
            >Отвод, м
            <input v-model="input.taperMetres" type="text" inputmode="decimal" required />
          </label>
          <label
            >Буфер, м
            <input v-model="input.bufferMetres" type="text" inputmode="decimal" required />
          </label>
        </div>
        <p v-if="choice" class="hint" role="status">
          По длине фронта предварительно выбран вариант
          <strong>{{ choice.code.toUpperCase() }}</strong
          >.
          <span v-if="choice.boundaryNeedsReview">
            Ровно 30 м требует предметной сверки подписей и размеров рисунков ОДМ.
          </span>
        </p>
        <h3>Три ступени скорости, км/ч</h3>
        <div class="fields compact">
          <label
            >Первая
            <input v-model="input.speedStagesKmh[0]" type="text" inputmode="decimal" required
          /></label>
          <label
            >Вторая
            <input v-model="input.speedStagesKmh[1]" type="text" inputmode="decimal" required
          /></label>
          <label
            >Третья
            <input v-model="input.speedStagesKmh[2]" type="text" inputmode="decimal" required
          /></label>
        </div>
        <label class="checkbox">
          <input v-model="input.yellowTemporarySigns" type="checkbox" />
          Жёлтый фон временных знаков
        </label>
        <p v-if="error" class="error" role="alert">{{ error }}</p>
        <button type="submit" class="primary">Создать проект</button>
      </fieldset>
    </form>
  </section>
</template>

<style scoped>
h2 {
  margin-top: 0;
}
h3 {
  font-size: 1rem;
}
.hint {
  color: #526273;
  line-height: 1.5;
}
.error {
  color: #a22030;
  font-weight: 600;
}
fieldset {
  border: 0;
  margin: 0;
  padding: 0;
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
button {
  padding: 0.7rem 1rem;
  border: 1px solid #185ca5;
  border-radius: 0.45rem;
  background: #185ca5;
  color: #fff;
  cursor: pointer;
  font: inherit;
  font-weight: 600;
}
button:disabled {
  opacity: 0.55;
}
button:focus-visible {
  outline: 2px solid #185ca5;
  outline-offset: 2px;
}
</style>
