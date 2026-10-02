<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { linkPu66Card } from '../domain/link-pu66'
import type { Scheme } from '../domain/model'
import type { Pu66SchemeRecord } from '../domain/pu66-snapshot'
import { annualPu66ReviewStatus, localCalendarDate } from '../domain/pu66-review'
import { getPu66SchemeRecord, listPu66Cards, type Pu66ListEntry } from '../services/local-pu66'
import Pu66CardPicker from './Pu66CardPicker.vue'
import { usePu66Status } from '../composables/usePu66Status'
import { exclusionReasons } from '../domain/pu66-lifecycle'

const props = defineProps<{ scheme: Scheme; locked?: boolean; refreshKey?: number }>()
const currentKey = computed(() => props.scheme.crossing.referenceId)
const {
  status: currentStatus,
  unavailable: statusUnavailable,
  reload: reloadStatus,
} = usePu66Status(currentKey)
const emit = defineEmits<{ apply: [scheme: Scheme] }>()
const cards = ref<Pu66ListEntry[]>([])
const key = ref('')
const preview = ref<Pu66SchemeRecord | null>(null)
const busy = ref(false)
const error = ref('')
const notice = ref('')
const selectedVerification = computed(
  () => cards.value.find((card) => card.referenceId === key.value)?.verification ?? null,
)

const reviewStatus = computed(() =>
  annualPu66ReviewStatus(
    selectedVerification.value?.verifiedAt ?? null,
    localCalendarDate(new Date()),
  ),
)

const alreadyLinked = computed(() => {
  if (!preview.value || props.scheme.crossing.source !== 'local-pu66') return false
  const { referenceId, ...snapshot } = preview.value
  return (
    props.scheme.crossing.referenceId === referenceId &&
    JSON.stringify(props.scheme.crossing.snapshot) === JSON.stringify(snapshot)
  )
})

watch(
  () => props.scheme.id,
  () => {
    key.value = ''
    preview.value = null
    error.value = ''
    notice.value = ''
  },
)

async function load(): Promise<void> {
  busy.value = true
  error.value = ''
  notice.value = ''
  preview.value = null
  try {
    await reloadStatus()
    cards.value = await listPu66Cards()
  } catch (cause) {
    cards.value = []
    error.value = cause instanceof Error ? cause.message : 'Не удалось прочитать реестр ПУ-66.'
  } finally {
    busy.value = false
  }
}

watch(
  () => props.refreshKey,
  () => void load(),
)
async function chooseSuccessor(): Promise<void> {
  const successor = currentStatus.value?.successorKey
  if (!successor || busy.value || props.locked) return
  await load()
  if (props.locked || !cards.value.some((card) => card.referenceId === successor)) return
  key.value = successor
  await choose()
}

async function choose(): Promise<void> {
  preview.value = null
  error.value = ''
  notice.value = ''
  const selectedKey = key.value
  if (!selectedKey) return
  const listed = cards.value.find((card) => card.referenceId === selectedKey)
  if (!listed) return
  busy.value = true
  try {
    const selected = await getPu66SchemeRecord(selectedKey)
    if (key.value !== selectedKey) return
    if (selected.revision !== listed.revision) {
      throw new Error('Карточка изменилась после загрузки списка. Обновите реестр.')
    }
    preview.value = selected
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'Карточка не открылась.'
  } finally {
    busy.value = false
  }
}

async function apply(): Promise<void> {
  if (!preview.value || busy.value || props.locked || alreadyLinked.value) return
  const openScheme = props.scheme
  const selected = preview.value
  busy.value = true
  error.value = ''
  notice.value = ''
  try {
    const latest = await getPu66SchemeRecord(selected.referenceId)
    if (props.scheme !== openScheme || props.locked || key.value !== selected.referenceId) return
    if (latest.revision !== selected.revision || latest.updatedAt !== selected.updatedAt) {
      preview.value = null
      throw new Error('Карточка обновлена. Обновите список и проверьте новую редакцию.')
    }
    emit('apply', linkPu66Card(openScheme, latest))
    notice.value = `Редакция № ${latest.revision} закреплена в открытом проекте. Сохраните черновик или JSON-копию.`
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'Не удалось закрепить карточку.'
  } finally {
    busy.value = false
  }
}

onMounted(load)
</script>

<template>
  <section aria-labelledby="pu66-link-title">
    <h2 id="pu66-link-title">Карточка переезда для схемы</h2>
    <div v-if="currentStatus?.excluded && currentStatus.event" class="warning" role="status">
      <p>
        Карточка исключена {{ currentStatus.event.date }}:
        {{ currentStatus.event.reason ? exclusionReasons[currentStatus.event.reason] : '' }}.
        {{ currentStatus.event.comment }} Сохранённый снимок проекта остаётся прежним. На этапе 4
        требуется ручная проверка перед выпуском.
      </p>
      <button
        v-if="currentStatus.successorKey"
        type="button"
        :disabled="busy || locked"
        @click="chooseSuccessor"
      >
        Сравнить с преемником {{ currentStatus.successorKey }}
      </button>
    </div>
    <p v-if="statusUnavailable" role="alert">
      Статус карточки недоступен. Обновите список перед выпуском.
    </p>
    <p class="hint">
      Выберите карточку из локального реестра и проверьте её данные перед закреплением. В JSON
      попадут только показанные ниже поля, номер редакции и время обновления записи. Выбор карточки
      не подтверждает её актуальность и не считается нормативной проверкой.
    </p>
    <p>
      Сейчас:
      <strong>{{ scheme.crossing.referenceId }}</strong>
      <template v-if="scheme.crossing.source === 'local-pu66'">
        · локальная редакция № {{ scheme.crossing.snapshot.revision }} ({{
          new Date(scheme.crossing.snapshot.updatedAt).toLocaleString('ru-RU')
        }})
      </template>
      <template v-else>· карточка не закреплена</template>
    </p>
    <div class="controls">
      <Pu66CardPicker
        v-model="key"
        id-prefix="pu66-link"
        :cards="cards"
        :disabled="busy || locked"
        @choose="choose"
      />
      <button type="button" :disabled="busy || locked" @click="load">Обновить список</button>
    </div>
    <p v-if="!cards.length && !busy" class="hint">Импортированных карточек пока нет.</p>
    <div v-if="preview">
      <p class="hint">Перед применением сравните старую привязку и выбранную карточку.</p>
      <p class="hint" role="status">
        {{
          reviewStatus.kind === 'unverified'
            ? 'Для этой редакции ПУ-66 сверка линейным подразделением не зарегистрирована.'
            : reviewStatus.kind === 'current'
              ? `Сверка зарегистрирована ${selectedVerification?.verifiedAt}; следующий срок — ${reviewStatus.nextDue}.`
              : `Срок ежегодной сверки наступил или прошёл (${reviewStatus.nextDue}). Уточните актуальность карточки.`
        }}
        Привязка не заменяет проверку перед выпуском схемы.
      </p>
      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th scope="col">Поле</th>
              <th scope="col">В проекте</th>
              <th scope="col">Выбрано</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <th scope="row">Идентификатор</th>
              <td>{{ scheme.crossing.referenceId }}</td>
              <td>{{ preview.referenceId }}</td>
            </tr>
            <tr>
              <th scope="row">Местоположение</th>
              <td>{{ scheme.crossing.snapshot?.location ?? 'не закреплено' }}</td>
              <td>{{ preview.location }}</td>
            </tr>
            <tr>
              <th scope="row">Подпись оси</th>
              <td>{{ scheme.crossing.snapshot?.axisLabel ?? 'не закреплено' }}</td>
              <td>{{ preview.axisLabel }}</td>
            </tr>
            <tr>
              <th scope="row">Дорога</th>
              <td>{{ scheme.crossing.snapshot?.roadName ?? 'не закреплено' }}</td>
              <td>{{ preview.roadName || 'не указана' }}</td>
            </tr>
            <tr>
              <th scope="row">Ширина проезжей части</th>
              <td>{{ scheme.crossing.snapshot?.crossingWidthMetres ?? 'не закреплено' }}</td>
              <td>{{ preview.crossingWidthMetres ?? 'не указана' }}</td>
            </tr>
            <tr>
              <th scope="row">Редакция и время обновления</th>
              <td>{{ scheme.crossing.snapshot?.revision ?? 'не закреплено' }}</td>
              <td>
                {{ preview.revision }} · {{ new Date(preview.updatedAt).toLocaleString('ru-RU') }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <button
        type="button"
        class="primary"
        :disabled="busy || locked || alreadyLinked"
        @click="apply"
      >
        {{ alreadyLinked ? 'Эта редакция уже закреплена' : 'Закрепить выбранную редакцию' }}
      </button>
    </div>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p v-if="notice" class="hint" role="status">{{ notice }}</p>
  </section>
</template>

<style scoped>
.hint {
  color: #526273;
  line-height: 1.5;
}
.error {
  color: #a22030;
  font-weight: 600;
}
.controls {
  display: flex;
  gap: 0.8rem;
  align-items: end;
  flex-wrap: wrap;
  margin: 1rem 0;
}
button {
  padding: 0.7rem 1rem;
  border: 1px solid #185ca5;
  border-radius: 0.45rem;
  background: #fff;
  color: #185ca5;
  cursor: pointer;
  font: inherit;
}
button.primary {
  background: #185ca5;
  color: #fff;
  margin: 0.8rem 0;
}
button:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
.table-scroll {
  overflow-x: auto;
}
table {
  width: 100%;
  border-collapse: collapse;
  margin-top: 0.8rem;
}
th,
td {
  text-align: left;
  padding: 0.55rem;
  border-bottom: 1px solid #d8e1eb;
}
th {
  font-weight: 600;
}
</style>
