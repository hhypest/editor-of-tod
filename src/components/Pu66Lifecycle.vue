<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { localCalendarDate } from '../domain/pu66-review'
import {
  exclusionReasons,
  type Pu66LifecycleWrite,
  type Pu66LifecyclePlan,
  type Pu66Status,
} from '../domain/pu66-lifecycle'
import {
  listPu66LifecycleCards,
  listPu66LifecycleHistory,
  previewPu66Lifecycle,
  applyPu66Lifecycle,
} from '../services/local-pu66'
import { invalidatePu66Status } from '../composables/usePu66Status'

const props = defineProps<{ locked?: boolean; refreshKey?: number }>()
const emit = defineEmits<{ changed: [] }>()
const cards = ref<Awaited<ReturnType<typeof listPu66LifecycleCards>>>([])
const excluded = ref(false)
const search = ref('')
const selected = ref<string[]>([])
const reason = ref<keyof typeof exclusionReasons>('reassigned')
const comment = ref('')
const actor = ref('')
const date = ref(localCalendarDate(new Date()))
const successorKey = ref('')
const busy = ref(false)
const error = ref('')
const notice = ref('')
const plan = ref<Pu66LifecyclePlan | null>(null)
const plannedInput = ref<Pu66LifecycleWrite | null>(null)
const history = ref<Array<NonNullable<Pu66Status['event']>>>([])
const historyKey = ref('')
let historyRequest = 0
const visible = computed(() =>
  cards.value.filter(
    (card) =>
      card.status.excluded === excluded.value &&
      `${card.referenceId} ${card.location} ${card.section} ${card.station} ${card.roadName}`
        .toLocaleLowerCase('ru')
        .includes(search.value.trim().toLocaleLowerCase('ru')),
  ),
)
const successors = computed(() =>
  cards.value.filter((card) => !card.status.excluded && !selected.value.includes(card.referenceId)),
)
const activeCount = computed(() => cards.value.filter((card) => !card.status.excluded).length)
const disabled = computed(() => busy.value || props.locked)

watch(
  [selected, reason, comment, actor, date, successorKey, excluded],
  () => {
    plan.value = null
    plannedInput.value = null
  },
  { deep: true },
)
watch(excluded, () => {
  selected.value = []
  historyKey.value = ''
  history.value = []
  historyRequest++
})
watch(
  () => props.refreshKey,
  () => void load(),
)

async function load(): Promise<void> {
  busy.value = true
  error.value = ''
  plan.value = null
  plannedInput.value = null
  selected.value = []
  try {
    cards.value = await listPu66LifecycleCards()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'Не удалось прочитать карточки.'
  } finally {
    busy.value = false
  }
}

async function preview(): Promise<void> {
  if (disabled.value || !selected.value.length) return
  busy.value = true
  error.value = ''
  notice.value = ''
  plan.value = null
  plannedInput.value = null
  const common = {
    keys: [...selected.value],
    date: date.value,
    actor: actor.value,
    comment: comment.value,
  }
  const input: Pu66LifecycleWrite = excluded.value
    ? { ...common, action: 'restore' }
    : {
        ...common,
        action: 'exclude',
        reason: reason.value,
        successorKey: successorKey.value || null,
      }
  try {
    const result = await previewPu66Lifecycle(input)
    plan.value = result
    plannedInput.value = input
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'Не удалось подготовить действие.'
  } finally {
    busy.value = false
  }
}

async function apply(): Promise<void> {
  if (disabled.value || !plan.value || !plannedInput.value) return
  busy.value = true
  error.value = ''
  const action = plannedInput.value.action
  try {
    const result = await applyPu66Lifecycle(plannedInput.value, plan.value.fingerprint)
    invalidatePu66Status()
    await load()
    historyKey.value = ''
    history.value = []
    historyRequest++
    emit('changed')
    notice.value =
      `${action === 'exclude' ? 'Исключено' : 'Возвращено'} карточек: ${result.changed}. ` +
      (result.backup ? `Резервная копия: ${result.backup}.` : '')
  } catch (cause) {
    plan.value = null
    plannedInput.value = null
    error.value = `${cause instanceof Error ? cause.message : 'Действие не выполнено.'} Просмотрите список заново.`
  } finally {
    busy.value = false
  }
}

async function showHistory(key: string): Promise<void> {
  const request = ++historyRequest
  historyKey.value = key
  history.value = []
  try {
    const result = await listPu66LifecycleHistory(key)
    if (request === historyRequest) history.value = result
  } catch (cause) {
    if (request === historyRequest)
      error.value = cause instanceof Error ? cause.message : 'История недоступна.'
  }
}
onMounted(load)
</script>

<template>
  <section aria-labelledby="pu66-lifecycle-title">
    <h2 id="pu66-lifecycle-title">Действующие и исключённые ПУ-66</h2>
    <p>
      Исключение убирает карточку из выбора новых проектов и ежегодной сверки. Книги, редакции и
      сохранённые проекты остаются в базе. Перед изменением создаётся резервная копия.
    </p>
    <div class="controls">
      <label
        >Список
        <select v-model="excluded" aria-label="Список" :disabled="disabled">
          <option :value="false">Действующие ({{ activeCount }})</option>
          <option :value="true">Исключённые ({{ cards.length - activeCount }})</option>
        </select></label
      >
      <label>Найти карточку <input v-model="search" type="search" maxlength="240" /></label>
      <button type="button" :disabled="disabled" @click="load">Обновить карточки</button>
    </div>
    <p v-if="error" role="alert" class="error">{{ error }}</p>
    <p v-if="notice" role="status">{{ notice }}</p>
    <p v-if="!visible.length && !busy">Карточек в этом списке нет.</p>
    <ul class="cards">
      <li v-for="card in visible" :key="card.referenceId">
        <label
          ><input
            v-model="selected"
            type="checkbox"
            :value="card.referenceId"
            :disabled="disabled"
          />
          <strong>{{ card.referenceId }}</strong> — {{ card.location }} ·
          {{ card.roadName || 'дорога не указана' }} · редакция {{ card.revision }}</label
        >
        <p v-if="card.status.excluded && card.status.event">
          Исключена {{ card.status.event.date }} · {{ card.status.event.actor }} ·
          {{ card.status.event.reason ? exclusionReasons[card.status.event.reason] : '' }}.
          {{ card.status.event.comment }}
          <span v-if="card.status.successorKey">Преемник: {{ card.status.successorKey }}.</span>
        </p>
        <button type="button" :disabled="disabled" @click="showHistory(card.referenceId)">
          История действий
        </button>
      </li>
    </ul>
    <details v-if="historyKey" open>
      <summary>История {{ historyKey }}</summary>
      <p v-if="!history.length">Записей пока нет.</p>
      <ul>
        <li v-for="event in history" :key="event.id">
          {{ event.date }} · {{ event.action === 'exclude' ? 'Исключение' : 'Возврат' }} ·
          {{ event.actor }} · редакция {{ event.cardRevision }}.
          {{ event.reason ? exclusionReasons[event.reason] : '' }} {{ event.comment }}
          <span v-if="event.successorKey">Преемник: {{ event.successorKey }}.</span>
        </li>
      </ul>
    </details>
    <form @submit.prevent="preview">
      <fieldset :disabled="disabled">
        <legend>
          {{ excluded ? 'Возврат в действующие' : 'Исключение карточек' }} · выбрано
          {{ selected.length }}
        </legend>
        <div class="fields">
          <label
            >Дата действия
            <input v-model="date" type="date" :max="localCalendarDate(new Date())" required
          /></label>
          <label>Кто выполнил <input v-model="actor" maxlength="240" required /></label>
          <label v-if="!excluded"
            >Причина
            <select v-model="reason" aria-label="Причина">
              <option v-for="(label, value) in exclusionReasons" :key="value" :value="value">
                {{ label }}
              </option>
            </select></label
          >
          <label v-if="!excluded"
            >Преемник (необязательно)
            <select v-model="successorKey" aria-label="Преемник (необязательно)">
              <option value="">Без преемника</option>
              <option v-for="card in successors" :key="card.referenceId" :value="card.referenceId">
                {{ card.referenceId }} · {{ card.location }}
              </option>
            </select></label
          >
          <label
            >Пояснение
            <textarea
              v-model="comment"
              maxlength="2000"
              :required="!excluded && reason === 'other'"
              rows="2"
            />
          </label>
        </div>
        <button type="submit" :disabled="!selected.length || selected.length > 100">
          {{ excluded ? 'Просмотреть возврат' : 'Просмотреть исключение' }}
        </button>
        <p v-if="selected.length > 100">Выберите не больше 100 карточек за одно действие.</p>
      </fieldset>
    </form>
    <div
      v-if="plan && plannedInput"
      class="preview"
      role="region"
      aria-label="План изменения ПУ-66"
    >
      <p>
        <strong
          >{{ plannedInput.action === 'exclude' ? 'Будут исключены' : 'Будут возвращены' }}:</strong
        >
        {{ plannedInput.date }} · {{ plannedInput.actor }}.
        {{ plannedInput.action === 'exclude' ? exclusionReasons[plannedInput.reason] : '' }}
        {{ plannedInput.comment }}
      </p>
      <p v-if="plan.successor">
        Преемник: {{ plan.successor.referenceId }} · {{ plan.successor.location }} ·
        {{ plan.successor.roadName }} · редакция {{ plan.successor.revision }}. Проекты
        перепривязываются вручную после сравнения данных.
      </p>
      <ul>
        <li v-for="card in plan.items" :key="card.referenceId">
          {{ card.referenceId }} — {{ card.location }} · {{ card.roadName }} · редакция
          {{ card.revision }}
        </li>
      </ul>
      <button type="button" :disabled="disabled" @click="apply">
        {{ plannedInput.action === 'exclude' ? 'Подтвердить исключение' : 'Подтвердить возврат' }} и
        создать копию
      </button>
    </div>
  </section>
</template>

<style scoped>
.controls,
.fields {
  display: flex;
  flex-wrap: wrap;
  gap: 0.8rem;
  align-items: end;
}
.controls label,
.fields label {
  display: grid;
  gap: 0.3rem;
  flex: 1 1 15rem;
  min-width: 0;
}
input,
select,
textarea {
  width: 100%;
  min-width: 0;
  max-width: 100%;
  box-sizing: border-box;
  padding: 0.55rem;
  border: 1px solid #93a5b8;
  border-radius: 0.35rem;
  font: inherit;
}
.cards {
  padding: 0;
  list-style: none;
  max-height: 24rem;
  overflow: auto;
}
.cards li,
.preview {
  border: 1px solid #cbd6df;
  padding: 0.8rem;
  margin: 0.5rem 0;
  border-radius: 0.4rem;
}
.cards label {
  line-height: 1.5;
}
.cards input {
  width: auto;
  margin-right: 0.5rem;
}
.error {
  color: #9c2020;
}
fieldset {
  min-inline-size: 0;
  margin-top: 1rem;
  padding: 0.8rem;
  border: 1px solid #cbd6df;
  border-radius: 0.4rem;
}
button {
  max-width: 100%;
  margin-top: 0.5rem;
  padding: 0.55rem 0.8rem;
  background: #fff;
  border: 1px solid #185ca5;
  border-radius: 0.35rem;
  color: #185ca5;
  font: inherit;
  cursor: pointer;
}
button:disabled {
  opacity: 0.5;
  cursor: default;
}
button:focus-visible {
  outline: 2px solid #185ca5;
  outline-offset: 2px;
}
</style>
