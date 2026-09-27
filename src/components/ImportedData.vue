<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import {
  annualPu66ReviewStatus,
  localCalendarDate,
  type Pu66Verification,
} from '../domain/pu66-review'
import { listPu66Verifications, recordPu66Verification } from '../services/local-pu66'

const props = defineProps<{ referencedSignIds: string[] }>()
type Sign = { code: string; width: number; height: number }
type Crossing = {
  referenceId: string
  location: string
  section: string
  roadName: string
  crossingWidthMetres: number | string | null
  crossingRoadLengthMetres: number | string | null
  carCountPerDay: number | string | null
  busRoutes: number | string | null
  revision: number
  updatedAt: string
  verification: Pu66Verification | null
}
const signs = ref<Sign[]>([])
const crossings = ref<Crossing[]>([])
const search = ref('')
const error = ref('')
const busy = ref(false)
const notice = ref('')
const verificationKey = ref('')
const verifiedAt = ref('')
const verifiedBy = ref('')
const verificationHistory = ref<Pu66Verification[]>([])
const historyBusy = ref(false)
let historyRequest = 0
const selectedCard = computed(() =>
  crossings.value.find((card) => card.referenceId === verificationKey.value),
)

function verificationStatus(card: Crossing): string {
  const status = annualPu66ReviewStatus(
    card.verification?.verifiedAt ?? null,
    localCalendarDate(new Date()),
  )
  if (status.kind === 'unverified') return 'Сверка этой редакции не зарегистрирована.'
  const suffix = `Следующий срок: ${status.nextDue}.`
  if (status.kind === 'due') return `Сверить сегодня. ${suffix}`
  if (status.kind === 'overdue') return `Срок сверки прошёл. ${suffix}`
  return `Сверка зарегистрирована. ${suffix}`
}

const visible = computed(() =>
  signs.value
    .filter((sign) => sign.code.toLowerCase().includes(search.value.trim().toLowerCase()))
    .slice(0, 48),
)
const referenced = computed(() =>
  props.referencedSignIds.map((code) => ({
    code,
    found: signs.value.some((sign) => sign.code === code),
  })),
)

async function load(): Promise<void> {
  busy.value = true
  error.value = ''
  try {
    const [cardsResponse, signsResponse] = await Promise.all([
      fetch('/api/pu66'),
      fetch('/api/signs'),
    ])
    if (!cardsResponse.ok || !signsResponse.ok)
      throw new Error('Не удалось прочитать локальный каталог.')
    crossings.value = (await cardsResponse.json()) as Crossing[]
    signs.value = (await signsResponse.json()) as Sign[]
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'Локальный каталог недоступен.'
  } finally {
    busy.value = false
  }
}

async function saveVerification(): Promise<void> {
  if (!selectedCard.value || !verifiedAt.value || !verifiedBy.value.trim()) return
  busy.value = true
  error.value = ''
  notice.value = ''
  try {
    await recordPu66Verification(selectedCard.value.referenceId, {
      expectedRevision: selectedCard.value.revision,
      verifiedAt: verifiedAt.value,
      verifiedBy: verifiedBy.value,
    })
    await load()
    await loadVerificationHistory(verificationKey.value)
    notice.value = 'Результат сверки записан для выбранной редакции ПУ-66.'
    verifiedAt.value = ''
    verifiedBy.value = ''
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'Не удалось записать сверку.'
  } finally {
    busy.value = false
  }
}

async function loadVerificationHistory(key: string): Promise<void> {
  const request = ++historyRequest
  verificationHistory.value = []
  historyBusy.value = !!key
  if (!key) return
  try {
    const history = await listPu66Verifications(key)
    if (request === historyRequest) verificationHistory.value = history
  } catch (cause) {
    if (request === historyRequest)
      error.value = cause instanceof Error ? cause.message : 'Не удалось прочитать историю сверок.'
  } finally {
    if (request === historyRequest) historyBusy.value = false
  }
}

watch(verificationKey, loadVerificationHistory)

function imageUrl(sign: Sign): string {
  return `/api/signs/${encodeURIComponent(sign.code)}/image`
}

onMounted(load)
</script>

<template>
  <section class="imported" aria-labelledby="imported-title">
    <h2 id="imported-title">Импортированные локальные каталоги</h2>
    <p>
      Загрузите разрешённые файлы командами из TESTING.MD на своём компьютере. После импорта
      обновите списки. Здесь показана краткая сводка для составителя; отдельная выборка для схемы
      содержит только её реквизиты. Полная исходная книга хранится в локальной базе.
    </p>
    <p v-if="error" role="alert" class="error">{{ error }}</p>
    <p v-if="notice" role="status">{{ notice }}</p>
    <button type="button" :disabled="busy" @click="load">Обновить каталоги</button>

    <h3>Локальная сверка импортированных карточек</h3>
    <p v-if="crossings.length === 0">Импортированных карточек пока нет.</p>
    <ul v-else>
      <li v-for="card in crossings" :key="card.referenceId">
        <strong>{{ card.location }}</strong> ({{ card.section }}) —
        {{ card.roadName || 'дорога не указана' }}. Ширина:
        {{ card.crossingWidthMetres ?? 'не указана' }} м; длина пересечения:
        {{ card.crossingRoadLengthMetres ?? 'не указана' }} м; автомобили в сутки:
        {{ card.carCountPerDay ?? 'не указано' }}.
        <small>Локальный ключ: {{ card.referenceId }}; редакция {{ card.revision }}.</small>
        <small>{{ verificationStatus(card) }}</small>
        <small v-if="card.verification">
          Дата: {{ card.verification.verifiedAt }}; выверил(а): {{ card.verification.verifiedBy }}.
        </small>
      </li>
    </ul>

    <form v-if="crossings.length" class="verification-form" @submit.prevent="saveVerification">
      <h4>Учёт ежегодной сверки ПУ-66</h4>
      <p>
        Линейное подразделение выверяет ПУ-66 30 января каждого года. Импорт Excel не отмечает
        карточку как выверенную. Записывайте результат только после фактической сверки; новая
        редакция файла потребует отдельной записи.
      </p>
      <label>
        Карточка
        <select v-model="verificationKey" :disabled="busy" required>
          <option value="">Выберите карточку</option>
          <option v-for="card in crossings" :key="card.referenceId" :value="card.referenceId">
            {{ card.location }} · редакция {{ card.revision }}
          </option>
        </select>
      </label>
      <label
        >Фактическая дата сверки
        <input v-model="verifiedAt" type="date" :max="localCalendarDate(new Date())" required
      /></label>
      <label
        >Линейное подразделение / ответственный
        <input v-model="verifiedBy" type="text" maxlength="240" required
      /></label>
      <button type="submit" :disabled="busy || !selectedCard">Записать результат сверки</button>
    </form>
    <div v-if="selectedCard">
      <h4>История сверок выбранной карточки</h4>
      <p v-if="historyBusy">Загрузка истории…</p>
      <p v-else-if="!verificationHistory.length">Записей пока нет.</p>
      <ul v-else>
        <li v-for="(record, index) in verificationHistory" :key="index">
          Редакция {{ record.cardRevision }} · сверена {{ record.verifiedAt }} ·
          {{ record.verifiedBy }} · запись внесена {{ record.recordedAt }}
        </li>
      </ul>
    </div>

    <h3>Каталог дорожных знаков</h3>
    <p>Найдено {{ signs.length }} знаков. Поиск показывает первые 48 совпадений.</p>
    <label for="sign-search">Номер знака</label>
    <input id="sign-search" v-model="search" type="search" placeholder="Например, 3.24_40_ж" />

    <div v-if="referenced.length" class="referenced">
      <h4>Знаки открытого JSON-проекта</h4>
      <ul>
        <li v-for="item in referenced" :key="item.code">
          {{ item.code }} — {{ item.found ? 'есть в каталоге' : 'не найден в каталоге' }}
        </li>
      </ul>
    </div>
    <div class="gallery">
      <figure v-for="sign in visible" :key="sign.code">
        <img :src="imageUrl(sign)" :alt="`Знак ${sign.code}`" loading="lazy" />
        <figcaption>{{ sign.code }}</figcaption>
      </figure>
    </div>
  </section>
</template>

<style scoped>
.imported {
  margin: 1rem 0;
  padding: 2rem;
  background: #fff;
  border: 1px solid #d8e1eb;
  border-radius: 0.8rem;
}
h2 {
  margin-top: 0;
}
.error {
  color: #a22030;
  font-weight: 600;
}
small {
  color: #526273;
}
small {
  display: block;
}
li {
  margin: 0.5rem 0;
}
button {
  padding: 0.55rem 0.8rem;
  border: 1px solid #185ca5;
  border-radius: 0.35rem;
  background: #fff;
  color: #185ca5;
  cursor: pointer;
  font: inherit;
}
input[type='search'] {
  margin: 0.4rem 0.8rem;
  padding: 0.55rem;
  border: 1px solid #93a5b8;
  border-radius: 0.35rem;
  font: inherit;
}
.verification-form {
  display: flex;
  flex-wrap: wrap;
  align-items: end;
  gap: 0.8rem;
  margin: 1rem 0;
  padding: 1rem;
  border: 1px solid #d8e1eb;
  border-radius: 0.4rem;
}
.verification-form h4,
.verification-form p {
  flex-basis: 100%;
  margin: 0;
}
.verification-form label {
  display: grid;
  gap: 0.25rem;
}
.verification-form input,
.verification-form select {
  padding: 0.5rem;
  font: inherit;
}
.gallery {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(8rem, 1fr));
  gap: 0.7rem;
  max-height: 34rem;
  overflow: auto;
}
figure {
  margin: 0;
  padding: 0.8rem;
  border: 1px solid #d8e1eb;
  border-radius: 0.4rem;
  text-align: center;
}
img {
  width: 100%;
  height: 6rem;
  object-fit: contain;
}
</style>
