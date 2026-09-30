<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import {
  createSchemeFromPu66,
  createUnlinkedScheme,
  SchemeCreationError,
  type NewSchemeInput,
} from '../domain/create-scheme'
import type { Scheme } from '../domain/model'
import type { Pu66SchemeRecord } from '../domain/pu66-snapshot'
import { selectTemplateByWorkFront, templateLabel } from '../domain/registry'
import { getPu66SchemeRecord, listPu66Cards, type Pu66ListEntry } from '../services/local-pu66'
import Pu66CardPicker from './Pu66CardPicker.vue'

const props = defineProps<{ locked?: boolean; active?: boolean }>()
const emit = defineEmits<{ create: [scheme: Scheme]; importPu66: [] }>()
const input = reactive<NewSchemeInput>({
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
const cards = ref<Pu66ListEntry[]>([])
/** Состояние реестра ПУ-66: без карточек (`empty`, `unavailable`) создать проект нельзя. */
const registry = ref<'loading' | 'ready' | 'empty' | 'unavailable'>('loading')
const cardKey = ref('')
const card = ref<Pu66SchemeRecord | null>(null)
const busy = ref(false)
/**
 * Номер попытки создания. Он меняется, если после нажатия «Создать проект» форма скрыта,
 * открывается другой проект (родитель блокирует форму) или меняется выбранная карточка:
 * тогда ответ реестра, пришедший позже, уже не создаёт проект.
 */
let attempt = 0
watch(
  () => [props.locked, props.active, cardKey.value] as const,
  ([locked, active], previous) => {
    if (locked || active === false || previous?.[2] !== cardKey.value) attempt++
  },
)
const choice = computed(() => {
  const value = input.frontMetres.trim().replace(',', '.')
  if (!/^\d+(?:\.\d+)?$/.test(value)) return null
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? selectTemplateByWorkFront(number) : null
})

async function loadCards(): Promise<void> {
  try {
    cards.value = await listPu66Cards()
    registry.value = cards.value.length ? 'ready' : 'empty'
  } catch {
    cards.value = []
    registry.value = 'unavailable'
  }
  // Выбранная карточка могла исчезнуть из реестра после восстановления резервной копии.
  if (cardKey.value && !cards.value.some((item) => item.referenceId === cardKey.value)) forgetCard()
}

async function chooseCard(key: string): Promise<void> {
  card.value = null
  error.value = ''
  if (!key) return
  busy.value = true
  try {
    const selected = await getPu66SchemeRecord(key)
    if (cardKey.value !== key) return
    card.value = selected
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'Карточка не открылась.'
  } finally {
    busy.value = false
  }
}

function forgetCard(): void {
  cardKey.value = ''
  card.value = null
}

async function create(): Promise<void> {
  error.value = ''
  const current = ++attempt
  busy.value = true
  try {
    const selected = card.value
    if (!selected) {
      error.value =
        'Новую схему можно начать только с карточки ПУ-66 из локального реестра. Выберите карточку.'
      return
    }
    // Условия проверяются до повторного чтения карточки, чтобы ошибка ввода была видна сразу.
    createUnlinkedScheme({ ...input, referenceId: selected.referenceId })
    // Карточку перечитываем перед созданием: запись могла обновиться после просмотра.
    const latest = await getPu66SchemeRecord(selected.referenceId)
    if (current !== attempt || props.locked) {
      error.value =
        'Создание проекта отменено: за время чтения карточки открыт другой раздел или проект.'
      return
    }
    if (latest.revision !== selected.revision || latest.updatedAt !== selected.updatedAt) {
      card.value = latest
      error.value = `Карточка обновлена до редакции № ${latest.revision}. Проверьте данные и создайте проект ещё раз.`
      return
    }
    emit('create', createSchemeFromPu66(input, latest))
  } catch (cause) {
    error.value =
      cause instanceof SchemeCreationError || cause instanceof Error
        ? cause.message
        : 'Не удалось создать проект.'
  } finally {
    busy.value = false
  }
}

onMounted(loadCards)
// Карточки могли импортировать в «Реестрах», пока форма была скрыта.
watch(
  () => props.active,
  (active, previous) => {
    if (active && previous === false) void loadCards()
  },
)
</script>

<template>
  <section aria-labelledby="new-scheme-title">
    <h2 id="new-scheme-title">Новый проект по карточке ПУ-66</h2>
    <p class="hint">
      Новая схема начинается только с карточки переезда из локального реестра ПУ-66: идентификатор,
      местоположение, подпись оси, дорога и ширина проезжей части попадут в проект из выбранной
      редакции карточки. Измеренные размеры и скорости заполните сами. Выбор карточки не считается
      её сверкой. После ввода условий на этапе 2 можно собрать условную расстановку на этапе 3.
    </p>
    <div v-if="registry === 'empty' || registry === 'unavailable'" class="blocked" role="alert">
      <p v-if="registry === 'empty'">
        <strong>В локальном реестре нет карточек ПУ-66 — начать новый проект невозможно.</strong>
        Импортируйте книги ПУ-66 в разделе «Реестры», затем вернитесь сюда.
      </p>
      <p v-else>
        <strong>Локальный реестр ПУ-66 недоступен — начать новый проект невозможно.</strong>
        Проверьте, что локальный сервер запущен, и повторите попытку.
      </p>
      <div class="actions">
        <button
          v-if="registry === 'empty'"
          type="button"
          class="primary"
          @click="emit('importPu66')"
        >
          Импортировать ПУ-66
        </button>
        <button type="button" class="secondary" @click="loadCards">Проверить снова</button>
      </div>
      <p class="hint">
        Сохранённые черновики и прежние JSON-проекты по-прежнему открываются во вкладках «Черновики
        SQLite» и «Открыть JSON».
      </p>
    </div>
    <form v-else @submit.prevent="create">
      <fieldset :disabled="locked || busy || registry === 'loading'">
        <section class="card" aria-labelledby="new-scheme-card-title">
          <h3 id="new-scheme-card-title">Карточка ПУ-66</h3>
          <Pu66CardPicker
            v-if="cards.length"
            v-model="cardKey"
            id-prefix="new-scheme-pu66"
            :cards="cards"
            @choose="chooseCard"
          />
          <p v-if="registry === 'loading'" class="hint">Читаю локальный реестр ПУ-66…</p>
          <p v-else-if="!card" class="hint">
            Найдите и выберите карточку переезда — без неё проект не создаётся.
          </p>
          <div v-if="card" class="preview" role="status">
            <p class="hint">Будет закреплено в проекте (редакция № {{ card.revision }}):</p>
            <dl>
              <dt>Идентификатор</dt>
              <dd>{{ card.referenceId }}</dd>
              <dt>Местоположение</dt>
              <dd>{{ card.location }}</dd>
              <dt>Подпись оси</dt>
              <dd>{{ card.axisLabel }}</dd>
              <dt>Дорога</dt>
              <dd>{{ card.roadName || 'не указана' }}</dd>
              <dt>Ширина проезжей части, м</dt>
              <dd>{{ card.crossingWidthMetres ?? 'не указана' }}</dd>
            </dl>
            <button type="button" class="secondary" @click="forgetCard">Выбрать другую</button>
          </div>
        </section>
        <div class="fields">
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
          <strong>{{ templateLabel(choice.code) }}</strong
          >.
          <span v-if="choice.boundaryNeedsReview">
            Ровно 30 м: Б.33 по подтверждённому правилу проекта; подписи и размеры рисунков ОДМ
            различаются.
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
        <button type="submit" class="primary" :disabled="!card">Создать проект</button>
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
button.secondary {
  background: #fff;
  color: #185ca5;
  font-weight: 400;
}
.blocked {
  padding: 0.9rem 1rem;
  border-left: 3px solid #b7791f;
  border-radius: 0.35rem;
  background: #fff8e8;
  line-height: 1.5;
}
.blocked p {
  margin: 0 0 0.7rem;
}
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.6rem;
  margin-bottom: 0.7rem;
}
.card {
  margin-bottom: 1rem;
  padding: 0.8rem 1rem;
  border: 1px solid #d8e1eb;
  border-radius: 0.45rem;
}
.card h3 {
  margin: 0 0 0.6rem;
}
.preview dl {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 0.3rem 1rem;
  margin: 0.4rem 0 0.8rem;
}
.preview dt {
  font-weight: 600;
}
.preview dd {
  margin: 0;
}
input[readonly] {
  background: #eef2f6;
}
button:focus-visible {
  outline: 2px solid #185ca5;
  outline-offset: 2px;
}
</style>
