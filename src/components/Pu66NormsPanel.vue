<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useNormativeRules } from '../composables/useNormativeRules'
import {
  cellNumber,
  hourlyFromDaily,
  isDiscrepancy,
  normRows,
  typesizeRowForCategory,
  type NormCheck,
  type Pu66Norms,
} from '../domain/pu66-norms'
import { getPu66Norms } from '../services/local-normatives'

const props = defineProps<{
  referenceId: string
  /** Редакция карточки, закреплённая в проекте. */
  pinnedRevision: number
  location: 'auto' | 'in' | 'out'
  locked?: boolean
}>()
const emit = defineEmits<{
  hourly: [value: string]
  typesize: [value: 'I' | 'II' | 'III' | 'IV']
}>()
const { rules } = useNormativeRules()

const norms = ref<Pu66Norms | null>(null)
const error = ref('')
const loading = ref(false)

async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    norms.value = await getPu66Norms(props.referenceId)
    if (!norms.value) error.value = 'Карточки нет в локальной базе: сведения ПУ-66 недоступны.'
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'Не удалось прочитать карточку ПУ-66.'
  } finally {
    loading.value = false
  }
}
watch(() => props.referenceId, load, { immediate: true })

const shareConfirmed = computed(() => rules.value.confirmed['peak-hour-share'])
const hourly = computed(() =>
  norms.value && shareConfirmed.value
    ? hourlyFromDaily(norms.value.carCountPerDay, rules.value.peakHourShare)
    : null,
)

const typesizeRow = computed(() =>
  norms.value && props.location !== 'in' ? typesizeRowForCategory(norms.value.roadCategory) : null,
)
const typesize = computed(() =>
  typesizeRow.value ? (rules.value.typesize[typesizeRow.value] ?? null) : null,
)
const selectable = computed(() =>
  typesize.value === 'I' ||
  typesize.value === 'II' ||
  typesize.value === 'III' ||
  typesize.value === 'IV'
    ? typesize.value
    : null,
)

const rows = computed(() => (norms.value ? normRows(norms.value.technicalRows) : []))
/** Все числовые расхождения, включая отличие от точного значения нормы. */
const problems = computed(() => rows.value.filter((row) => isDiscrepancy(row.check)))
const showAll = ref(false)
/** По умолчанию — только строки с расхождением; полная таблица по кнопке. */
const shownRows = computed(() => (showAll.value ? rows.value : problems.value))

const checkLabels: Record<NormCheck, string> = {
  ok: 'соответствует',
  below: 'меньше нормы',
  above: 'больше нормы',
  differs: 'отличается от нормы',
  unknown: '',
}

function show(value: string | number | null): string {
  return value === null || value === '' ? '—' : String(value)
}
</script>

<template>
  <section class="pu66-norms" aria-labelledby="pu66-norms-title">
    <h3 id="pu66-norms-title">Сведения ПУ-66 для нормативов</h3>
    <p v-if="loading" role="status">Чтение карточки…</p>
    <p v-if="error" class="error">{{ error }}</p>
    <template v-if="norms">
      <p v-if="norms.revision !== pinnedRevision" class="warning">
        В локальной базе редакция карточки {{ norms.revision }}, в проекте закреплена
        {{ pinnedRevision }}. Показаны сведения из базы.
      </p>
      <dl>
        <dt>Интенсивность</dt>
        <dd>
          {{ show(norms.carCountPerDay) }} авт/сут
          <template v-if="cellNumber(norms.carCountPerDay) === null">
            — числа нет в карточке.</template
          >
          <template v-else-if="!shareConfirmed">
            — для пересчёта в авт/ч подтвердите долю часа пик в «Реестры» → «Нормативные параметры».
          </template>
          <template v-else-if="hourly !== null">
            × {{ rules.peakHourShare }} (доля часа пик, решение составителя) ≈ {{ hourly }} авт/ч.
            <button type="button" :disabled="locked" @click="emit('hourly', String(hourly))">
              Подставить {{ hourly }} авт/ч
            </button>
          </template>
        </dd>
        <dt>Категория дороги</dt>
        <dd>
          {{ show(norms.roadCategory) }}.
          <template v-if="location === 'in'">
            В населённом пункте типоразмер выбирают по классу улицы (ГОСТ Р 52289, табл. 1); в ПУ-66
            его нет.
          </template>
          <template v-else-if="typesizeRow && typesize">
            Предварительно строка «{{ typesizeRow }}» → типоразмер {{ typesize }} ({{
              rules.sources['gost-sign-typesize']
            }}{{ rules.confirmed['gost-sign-typesize'] ? '' : '; параметр не подтверждён' }}). Число
            полос по категории проверьте на месте.
            <button
              v-if="selectable"
              type="button"
              :disabled="locked"
              @click="emit('typesize', selectable)"
            >
              Выбрать типоразмер {{ selectable }}
            </button>
          </template>
          <template v-else> Строку таблицы типоразмеров по этой категории не определить. </template>
        </dd>
        <dt>Видимость поезда, м</dt>
        <dd>
          справа: нечётного {{ show(norms.trainVisibilityMetres.rightOdd) }}, чётного
          {{ show(norms.trainVisibilityMetres.rightEven) }}; слева: нечётного
          {{ show(norms.trainVisibilityMetres.leftOdd) }}, чётного
          {{ show(norms.trainVisibilityMetres.leftEven) }}
        </dd>
      </dl>
      <details :open="problems.length > 0">
        <summary>
          Техническая таблица и графа «Норма» ·
          {{
            problems.length
              ? `расхождений с нормой: ${problems.length}`
              : 'числовых несоответствий не найдено'
          }}
        </summary>
        <p class="hint">
          Сравниваются только числовые нормы («не менее», «не более», число). Словесные нормы
          показаны без оценки. Графа «Норма» — из карточки ПУ-66; отклонение не означает ошибку
          карточки, его проверяет составитель.
        </p>
        <table>
          <thead>
            <tr>
              <th>Пункт</th>
              <th>Показатель</th>
              <th>Норма</th>
              <th>{{ norms.years.current || 'Факт' }}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(row, index) in shownRows" :key="index" :class="row.check">
              <td>{{ row.item }}</td>
              <td>{{ row.label }}</td>
              <td>{{ show(row.statedNorm) }}</td>
              <td>{{ show(row.current) }}</td>
              <td>{{ checkLabels[row.check] }}</td>
            </tr>
          </tbody>
        </table>
        <p v-if="!shownRows.length" class="hint">Строк с расхождением нет.</p>
        <button type="button" @click="showAll = !showAll">
          {{ showAll ? 'Только расхождения' : `Показать все строки (${rows.length})` }}
        </button>
      </details>
      <p class="hint">
        Эти сведения видны только в локальном редакторе и не записываются в файл проекта и на лист.
      </p>
    </template>
  </section>
</template>

<style scoped>
.pu66-norms {
  margin: 1rem 0;
  padding: 0.8rem 1rem;
  border: 1px solid #d8e1eb;
  border-radius: 0.5rem;
  background: #fbfcfe;
}
h3 {
  margin-top: 0;
}
dl {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 0.4rem 1rem;
}
dt {
  font-weight: 600;
}
dd {
  margin: 0;
}
button {
  margin-left: 0.4rem;
  padding: 0.3rem 0.6rem;
  border: 1px solid #185ca5;
  border-radius: 0.35rem;
  background: #fff;
  color: #185ca5;
  cursor: pointer;
  font: inherit;
}
.hint {
  color: #526273;
}
.error {
  color: #a22030;
}
.warning {
  color: #8a5a00;
}
table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.9rem;
}
th,
td {
  padding: 0.3rem;
  border-bottom: 1px solid #e3e9f0;
  text-align: left;
  vertical-align: top;
}
tr.below td,
tr.above td {
  background: #fdecee;
}
tr.differs td:last-child {
  color: #8a5a00;
}
</style>
