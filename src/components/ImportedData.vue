<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import {
  annualPu66ReviewStatus,
  localCalendarDate,
  type Pu66Verification,
} from '../domain/pu66-review'
import {
  applyPu66Files,
  listPu66Verifications,
  MAX_WEB_PU66_FILES,
  previewPu66Files,
  recordPu66Verification,
  type Pu66ImportPlan,
} from '../services/local-pu66'
import {
  applySignFiles,
  getSignCatalog,
  MAX_WEB_SIGN_ARCHIVE_BYTES,
  MAX_WEB_SIGN_PDF_BYTES,
  previewSignFiles,
  type SignCatalog,
  type SignImportPlan,
} from '../services/local-signs'

const props = defineProps<{ referencedSignIds: string[]; locked: boolean }>()
const emit = defineEmits<{ signsUpdated: [] }>()
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
const importFiles = ref<File[]>([])
const importInput = ref<HTMLInputElement | null>(null)
const importPlan = ref<Pu66ImportPlan | null>(null)
const importBusy = ref(false)
const signArchive = ref<File | null>(null)
const signPdf = ref<File | null>(null)
const signDocumentCode = ref('ГОСТ Р 52290-2024')
const signEdition = ref('2024')
const signPlan = ref<SignImportPlan | null>(null)
const signCatalog = ref<SignCatalog | null>(null)
const signBusy = ref(false)
const signNotice = ref('')
const signError = ref('')
const signZipInput = ref<HTMLInputElement | null>(null)
const signPdfInput = ref<HTMLInputElement | null>(null)
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
    const [cardsResponse, signsResponse, catalog] = await Promise.all([
      fetch('/api/pu66'),
      fetch('/api/signs'),
      getSignCatalog(),
    ])
    if (!cardsResponse.ok || !signsResponse.ok)
      throw new Error('Не удалось прочитать локальный каталог.')
    crossings.value = (await cardsResponse.json()) as Crossing[]
    signs.value = (await signsResponse.json()) as Sign[]
    signCatalog.value = catalog
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'Локальный каталог недоступен.'
  } finally {
    busy.value = false
  }
}

function changeSignFiles(event: Event, kind: 'zip' | 'pdf'): void {
  const file = (event.target as HTMLInputElement).files?.[0] ?? null
  if (kind === 'zip') signArchive.value = file
  else signPdf.value = file
  signPlan.value = null
  signError.value = ''
  signNotice.value = ''
}

async function previewSigns(): Promise<void> {
  if (!signArchive.value || props.locked) return
  signBusy.value = true
  signError.value = ''
  signNotice.value = ''
  signPlan.value = null
  try {
    signPlan.value = await previewSignFiles(
      signArchive.value,
      signPdf.value,
      signDocumentCode.value,
      signEdition.value,
    )
  } catch (cause) {
    signError.value = cause instanceof Error ? cause.message : 'Не удалось проверить архив.'
  } finally {
    signBusy.value = false
  }
}

async function applySigns(): Promise<void> {
  if (!signPlan.value || !signArchive.value || props.locked) return
  signBusy.value = true
  signError.value = ''
  try {
    const result = await applySignFiles(
      signArchive.value,
      signPdf.value,
      signDocumentCode.value,
      signEdition.value,
      signPlan.value.fingerprint,
    )
    signPlan.value = null
    signArchive.value = null
    signPdf.value = null
    if (signZipInput.value) signZipInput.value.value = ''
    if (signPdfInput.value) signPdfInput.value.value = ''
    await load()
    emit('signsUpdated')
    signNotice.value = `Знаки: новых ${result.added}, обновлено ${result.updated}, исключено из текущего набора ${result.retired}. ${result.backup ? `Копия SQLite: private-data/backups/${result.backup}.` : 'Изменений нет.'}`
  } catch (cause) {
    signPlan.value = null
    signError.value = `${cause instanceof Error ? cause.message : 'Не удалось записать каталог.'} Повторите просмотр перед записью.`
  } finally {
    signBusy.value = false
  }
}

function selectImportFiles(event: Event): void {
  const input = event.target as HTMLInputElement
  importFiles.value = Array.from(input.files ?? [])
  importPlan.value = null
  error.value = ''
  notice.value = ''
}

async function previewImport(): Promise<void> {
  importBusy.value = true
  importPlan.value = null
  error.value = ''
  notice.value = ''
  try {
    importPlan.value = await previewPu66Files(importFiles.value)
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'Не удалось проверить книги ПУ-66.'
  } finally {
    importBusy.value = false
  }
}

async function applyImport(): Promise<void> {
  if (!importPlan.value || !importFiles.value.length) return
  importBusy.value = true
  error.value = ''
  notice.value = ''
  try {
    const result = await applyPu66Files(importFiles.value, importPlan.value.fingerprint)
    importPlan.value = null
    importFiles.value = []
    if (importInput.value) importInput.value.value = ''
    await load()
    notice.value = `ПУ-66: добавлено ${result.added}, обновлено ${result.updated}. Резервная копия: private-data/backups/${result.backup}. Импорт не подтверждает сверку.`
  } catch (cause) {
    importPlan.value = null
    error.value = `${cause instanceof Error ? cause.message : 'Не удалось импортировать ПУ-66.'} Выполните просмотр заново перед повторной записью.`
  } finally {
    importBusy.value = false
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
      Здесь показана краткая сводка для составителя; отдельная выборка для схемы содержит только её
      реквизиты. Полная исходная книга хранится в локальной базе. Для больших пакетов сохраняется
      командный импорт из TESTING.MD.
    </p>
    <p v-if="error" role="alert" class="error">{{ error }}</p>
    <p v-if="notice" role="status">{{ notice }}</p>
    <button type="button" :disabled="busy || importBusy" @click="load">Обновить каталоги</button>

    <div class="verification-form">
      <h3>Импорт ПУ-66 из Excel</h3>
      <p>
        Выберите до {{ MAX_WEB_PU66_FILES }} разрешённых файлов XLSX размером до 4 МБ каждый.
        Сначала просмотрите план, затем подтвердите запись. Книги отправляются только локальному
        процессу на этом компьютере; перед изменением SQLite создаётся резервная копия.
      </p>
      <label>
        Книги ПУ-66
        <input
          ref="importInput"
          type="file"
          accept=".xlsx"
          multiple
          :disabled="importBusy"
          @change="selectImportFiles"
        />
      </label>
      <button type="button" :disabled="importBusy || !importFiles.length" @click="previewImport">
        Просмотреть изменения
      </button>
      <p v-if="importBusy" role="status">Проверка книг или запись в локальную базу…</p>
      <div v-if="importPlan" class="import-plan">
        <p>
          Новых: {{ importPlan.added }}; обновлений: {{ importPlan.updated }}; без изменений:
          {{ importPlan.unchanged }}.
        </p>
        <ul>
          <li v-for="item in importPlan.items" :key="item.referenceId">
            {{ item.filename }} — {{ item.location }}; {{ item.roadName || 'дорога не указана' }}:
            {{
              item.action === 'add'
                ? 'новая карточка'
                : item.action === 'update'
                  ? `обновление редакции ${item.currentRevision}`
                  : `редакция ${item.currentRevision} без изменений`
            }}.
          </li>
        </ul>
        <button
          type="button"
          :disabled="importBusy || importPlan.added + importPlan.updated === 0"
          @click="applyImport"
        >
          Подтвердить импорт и создать копию SQLite
        </button>
      </div>
    </div>

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
    <div class="verification-form">
      <h4>Импорт PNG знаков из локального архива</h4>
      <p>
        Архив содержит пары «с номером» и «без номера». Укажите редакцию ГОСТ, с которой сверяли
        архив; PDF можно приложить для записи его SHA-256. Приложение не извлекает изображения из
        PDF и не подтверждает, что архив соответствует документу. Файлы остаются только в локальной
        базе, перед заменой создаётся резервная копия. Отсутствующие в новом архиве коды исключаются
        из текущего каталога, прежние редакции PNG сохраняются в SQLite.
      </p>
      <p v-if="locked" role="status">Сначала примените или отмените правки открытого проекта.</p>
      <label
        >Документ
        <input
          v-model="signDocumentCode"
          maxlength="120"
          :disabled="signBusy || locked"
          @input="signPlan = null"
      /></label>
      <label
        >Редакция
        <input
          v-model="signEdition"
          maxlength="120"
          :disabled="signBusy || locked"
          @input="signPlan = null"
      /></label>
      <label>
        ZIP знаков (до {{ MAX_WEB_SIGN_ARCHIVE_BYTES / 1024 / 1024 }} МБ)
        <input
          ref="signZipInput"
          type="file"
          accept=".zip"
          :disabled="signBusy || locked"
          @change="changeSignFiles($event, 'zip')"
        />
      </label>
      <label>
        PDF ГОСТ для хеша (необязательно, до {{ MAX_WEB_SIGN_PDF_BYTES / 1024 / 1024 }} МБ)
        <input
          ref="signPdfInput"
          type="file"
          accept=".pdf"
          :disabled="signBusy || locked"
          @change="changeSignFiles($event, 'pdf')"
        />
      </label>
      <button type="button" :disabled="signBusy || locked || !signArchive" @click="previewSigns">
        Просмотреть изменения знаков
      </button>
      <p v-if="signBusy" role="status">Проверка или запись локального каталога…</p>
      <p v-if="signError" role="alert" class="error">{{ signError }}</p>
      <p v-if="signNotice" role="status">{{ signNotice }}</p>
      <div v-if="signPlan" class="import-plan">
        <p>
          В архиве {{ signPlan.signCount }} знаков: новых {{ signPlan.added }}, обновлений
          {{ signPlan.updated }}, неизменных {{ signPlan.unchanged }}, исключается из текущего
          набора {{ signPlan.retired }}. Источник: {{ signPlan.source.documentCode }}, редакция
          {{ signPlan.source.edition
          }}{{
            signPlan.source.pdfSha256
              ? `, PDF SHA-256 ${signPlan.source.pdfSha256}`
              : ', PDF не выбран'
          }}.
        </p>
        <button
          type="button"
          :disabled="
            signBusy || locked || signPlan.added + signPlan.updated + signPlan.retired === 0
          "
          @click="applySigns"
        >
          Подтвердить каталог и создать копию SQLite
        </button>
      </div>
    </div>
    <p v-if="signCatalog">
      Текущий набор: {{ signCatalog.documentCode }}, редакция {{ signCatalog.edition }},
      {{ signCatalog.signCount }} знаков; импорт {{ signCatalog.importedAt }}.
    </p>
    <p v-else-if="signs.length">Для прежнего импорта редакция источника не указана.</p>
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
.verification-form h3,
.verification-form p {
  flex-basis: 100%;
  margin: 0;
}
.import-plan {
  flex-basis: 100%;
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
