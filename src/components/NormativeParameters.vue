<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import {
  parameterDefinitions,
  valueInForce,
  valueProblem,
  type ParameterDefinition,
  type ParameterState,
  type ParameterValue,
  type ParameterRejectionField,
} from '../domain/normative-parameters'
import { useNormativeRules } from '../composables/useNormativeRules'
import { confirmParameter, ParameterRequestError } from '../services/local-normatives'
import { documentPdfUrl } from '../services/local-documents'

const props = defineProps<{ refreshKey?: number; guided?: boolean }>()
const emit = defineEmits<{ busy: [value: boolean] }>()
const { states, loading, error: loadError, reload } = useNormativeRules()

const openId = ref<string | null>(null)
const WHO_KEY = 'tod.parameters.confirmedBy'
function remembered(): string {
  try {
    return localStorage.getItem(WHO_KEY) ?? ''
  } catch {
    return ''
  }
}
const confirmedBy = ref(remembered())
watch(confirmedBy, (value) => {
  try {
    localStorage.setItem(WHO_KEY, value)
  } catch {
    // Хранилище браузера недоступно: имя придётся ввести снова.
  }
})
const busy = ref(false)
watch(
  () => busy.value || loading.value,
  (value) => emit('busy', value),
  { immediate: true },
)
const error = ref('')
const errorField = ref<ParameterRejectionField>('request')
const notice = ref('')
/** Значение в форме: число строкой или строки таблицы. */
const form = reactive<{
  number: string
  rows: Array<{ key: string; value: string }>
  note: string
}>({ number: '', rows: [], note: '' })

const items = computed(() =>
  parameterDefinitions.map((definition) => ({
    definition,
    state: states.value.find((state) => state.id === definition.id) ?? null,
  })),
)
const guidedIndex = ref(0)
const shownItems = computed(() =>
  props.guided ? items.value.slice(guidedIndex.value, guidedIndex.value + 1) : items.value,
)
function selectParameter(index: number): void {
  if (busy.value) return
  guidedIndex.value = index
  openId.value = null
  const item = items.value[index]
  if (item) open(item.definition, item.state)
}
watch(
  () => [props.guided, states.value.length] as const,
  () => {
    if (!props.guided || !states.value.length || openId.value) return
    const missing = items.value.findIndex((item) => item.state?.status.kind !== 'confirmed')
    selectParameter(missing < 0 ? 0 : missing)
  },
  { immediate: true },
)

const confirmedCount = computed(
  () => states.value.filter((state) => state.status.kind === 'confirmed').length,
)

onMounted(() => void reload())
watch(
  () => props.refreshKey,
  () => void reload(),
)

function sourceText(definition: ParameterDefinition, state: ParameterState | null): string {
  const source = definition.source
  if (source.kind === 'decision') {
    const label = source.label
      ? `${source.label[0]!.toUpperCase()}${source.label.slice(1)}`
      : 'Решение составителя'
    return `${label}; основание записывается при подтверждении.`
  }
  const place = source.kind === 'table' ? source.clause : `п. ${source.clause}`
  return `${state?.document?.label ?? source.documentCode}, ${place}`
}

function statusText(definition: ParameterDefinition, state: ParameterState | null): string {
  const status = state?.status
  const confirmation = state?.confirmation
  if (!status) return 'Загрузка…'
  if (status.kind === 'confirmed')
    return `Подтверждено ${confirmation!.confirmedAt}, ${confirmation!.confirmedBy}.`
  if (status.kind === 'invalid')
    return `Подтверждение ${confirmation!.confirmedAt} не действует: ${status.problem} ${
      definition.fallback === null
        ? 'Без подтверждения значение не используется'
        : 'Расчёты используют значение прототипа'
    } — подтвердите заново.`
  if (status.kind === 'same-text')
    return `Подтверждено по ${status.previous}. В действующей версии фрагмент пункта не изменился — подтвердите по ней.`
  if (status.kind === 'changed')
    return `Подтверждено по ${status.previous}. В действующей версии фрагмент изменился или не найден — проверьте значение.`
  if (status.kind === 'no-document')
    return definition.source.kind === 'decision'
      ? 'Не подтверждено.'
      : `Нет действующей версии ${definition.source.documentCode} в «Нормативных документах».`
  return definition.fallback === null
    ? 'Не подтверждено: без подтверждения не используется.'
    : 'Не подтверждено: используется значение прототипа.'
}

function statusClass(state: ParameterState | null): string {
  const kind = state?.status.kind
  return kind === 'confirmed' ? 'ok' : kind === 'same-text' ? 'notice' : 'warn'
}

function valueText(definition: ParameterDefinition, value: ParameterValue | null): string {
  if (value === null) return 'нет'
  if (typeof value === 'number') return `${value}${definition.unit ? ` ${definition.unit}` : ''}`
  return Object.entries(value)
    .map(([key, cell]) => `${key} → ${cell}`)
    .join('; ')
}

/** Значение «в действии» — по тому же правилу, что и расчёты (`rulesFrom`). */
function inUse(
  definition: ParameterDefinition,
  state: ParameterState | null,
): ParameterValue | null {
  return valueInForce(definition, state?.confirmation)
}

function open(definition: ParameterDefinition, state: ParameterState | null): void {
  if (busy.value) return
  error.value = ''
  notice.value = ''
  if (openId.value === definition.id) {
    openId.value = null
    return
  }
  openId.value = definition.id
  // Недействующее подтверждение в форму не переносится: она начинается со значения в действии.
  const initial = state?.suggestion ?? inUse(definition, state)
  form.note = ''
  if (definition.type === 'number') {
    form.number = typeof initial === 'number' ? String(initial) : ''
    form.rows = []
  } else {
    const table = initial && typeof initial === 'object' ? initial : {}
    form.rows = Object.entries(table).map(([key, value]) => ({ key, value }))
    form.number = ''
  }
}

function formValue(definition: ParameterDefinition): ParameterValue | null {
  if (definition.type === 'number') {
    const input = form.number.trim().replace(',', '.')
    return /^\d+(?:\.\d+)?$/.test(input) ? Number(input) : null
  }
  const rows = form.rows.filter((row) => row.key.trim() && row.value.trim())
  return Object.fromEntries(rows.map((row) => [row.key.trim(), row.value.trim()]))
}

async function confirm(
  definition: ParameterDefinition,
  state: ParameterState | null,
): Promise<void> {
  error.value = ''
  notice.value = ''
  const value = formValue(definition)
  if (value === null) {
    error.value = 'Введите число.'
    errorField.value = 'value'
    return
  }
  const problem = valueProblem(definition, value)
  if (problem) {
    error.value = problem
    errorField.value = 'value'
    return
  }
  if (noteRequired(definition, state) && !form.note.trim()) {
    errorField.value = 'note'
    error.value =
      definition.source.kind === 'decision'
        ? 'Укажите основание решения: документ, расчёт или распоряжение.'
        : 'Пункт не найден в тексте PDF: укажите страницу и формулировку, по которым проверено значение.'
    return
  }
  busy.value = true
  try {
    await confirmParameter(definition.id, {
      value,
      confirmedBy: confirmedBy.value.trim(),
      note: form.note.trim(),
      expectedDocumentId: state?.document?.id ?? null,
    })
    await reload()
    notice.value = `«${definition.title}»: подтверждено значение ${valueText(definition, value)}.`
    openId.value = null
    if (props.guided) {
      const next = items.value.findIndex((item) => item.state?.status.kind !== 'confirmed')
      if (next >= 0) {
        guidedIndex.value = next
      }
    }
  } catch (cause) {
    errorField.value = cause instanceof ParameterRequestError ? cause.field : 'request'
    error.value = cause instanceof Error ? cause.message : 'Не удалось записать подтверждение.'
  } finally {
    busy.value = false
    if (props.guided && !openId.value) {
      const item = items.value[guidedIndex.value]
      if (item) open(item.definition, item.state)
    }
  }
}

function noteRequired(definition: ParameterDefinition, state: ParameterState | null): boolean {
  return definition.source.kind === 'decision' || Boolean(state?.document && !state.quote)
}

function fieldInvalid(field: ParameterRejectionField): boolean {
  return Boolean(error.value && errorField.value === field)
}

/** Таблица показывается построчно: заголовок, затем строки как в документе. */
function quoteText(quote: NonNullable<ParameterState['quote']>): string {
  if (!quote.rows?.length) return quote.text
  const start = quote.text.indexOf(quote.rows[0]!)
  const heading = start > 0 ? quote.text.slice(0, start).trim() : quote.text
  if (start <= 0) return heading
  return [heading, ...quote.rows].join('\n')
}

/** Цитата с выделенными числами: составитель сверяет значение с текстом пункта. */
function highlighted(text: string): Array<{ text: string; number: boolean }> {
  return (
    text
      .split(/(\d+(?:[.,]\d+)*)/u)
      .filter(Boolean)
      // Номера пунктов и документов («5.4.4», «34.13330.2012») не выделяются.
      .map((part) => ({ text: part, number: /^\d+(?:[.,]\d+)?$/.test(part) }))
  )
}
</script>

<template>
  <section class="parameters" aria-labelledby="parameters-title" :class="{ guided }">
    <h2 id="parameters-title">Нормативные параметры</h2>
    <p v-if="!guided" class="hint">
      Числа, которые программа использует в подсказках и сборке схемы. Для параметров документов
      указан документ и пункт: программа находит пункт в PDF действующей версии из «Нормативных
      документов», показывает цитату и предлагает значение. Проверьте его по тексту и подтвердите.
      Пока параметр не подтверждён, действует значение прототипа, а подсказка способа пропуска не
      применяется. После появления новой версии программа сравнит пункт и попросит подтвердить
      значение заново. Профиль переезда и доля часа пик — отдельные решения специалиста: укажите их
      основание; загрузка стандарта их не подтверждает.
    </p>
    <p v-if="!guided || !loadError">
      Подтверждено {{ confirmedCount }} из {{ parameterDefinitions.length }}.
      <button type="button" :disabled="loading" @click="reload">Обновить</button>
    </p>
    <p v-if="loading" role="status">
      Чтение текста документов… При первом запуске это до нескольких секунд.
    </p>
    <p v-if="loadError" role="alert" class="error">
      {{ loadError }}
      <button v-if="guided" type="button" :disabled="loading" @click="reload">
        Повторить загрузку параметров
      </button>
    </p>
    <p v-if="notice" role="status" class="ok-text">{{ notice }}</p>
    <label class="who"
      >Кто подтверждает (для журнала)
      <input
        v-model="confirmedBy"
        maxlength="240"
        placeholder="Должность, фамилия"
        :disabled="busy"
        :aria-invalid="fieldInvalid('confirmedBy')"
        :aria-describedby="fieldInvalid('confirmedBy') ? 'parameter-confirm-error' : undefined"
      />
    </label>

    <div v-if="guided" class="parameter-navigation">
      <label
        >Параметр
        <select
          :value="guidedIndex"
          :disabled="busy"
          @change="selectParameter(Number(($event.target as HTMLSelectElement).value))"
        >
          <option v-for="(item, index) in items" :key="item.definition.id" :value="index">
            {{ index + 1 }}. {{ item.definition.title
            }}{{ item.state?.status.kind === 'confirmed' ? ' — подтверждён' : '' }}
          </option>
        </select>
      </label>
      <button
        type="button"
        :disabled="busy || guidedIndex === 0"
        @click="selectParameter(guidedIndex - 1)"
      >
        Предыдущий параметр
      </button>
      <button
        type="button"
        :disabled="busy || guidedIndex === items.length - 1"
        @click="selectParameter(guidedIndex + 1)"
      >
        Следующий параметр
      </button>
    </div>
    <ul class="list">
      <li
        v-for="{ definition, state } in shownItems"
        :key="definition.id"
        :data-parameter="definition.id"
      >
        <div class="head">
          <div>
            <strong>{{ definition.title }}</strong>
            <small>{{ sourceText(definition, state) }} · {{ definition.usedIn }}</small>
          </div>
          <span class="value">{{ valueText(definition, inUse(definition, state)) }}</span>
        </div>
        <p :class="['status', statusClass(state)]">{{ statusText(definition, state) }}</p>
        <p v-if="state?.amendments.length" class="status warn">
          Действующие изменения упоминают этот пункт: {{ state.amendments.join(', ') }}. Проверьте
          значение с учётом изменения.
        </p>
        <button
          type="button"
          :aria-expanded="openId === definition.id"
          :disabled="busy"
          @click="open(definition, state)"
        >
          {{ openId === definition.id ? 'Свернуть' : 'Проверить и подтвердить' }}
        </button>

        <div v-if="openId === definition.id" class="confirm">
          <template v-if="definition.source.kind !== 'decision'">
            <p v-if="!state?.document" class="error">
              Прикрепите действующую версию {{ definition.source.documentCode }} в «Нормативных
              документах».
            </p>
            <template v-else>
              <blockquote v-if="state.quote" class="quote">
                <span
                  v-for="(part, index) in highlighted(quoteText(state.quote))"
                  :key="index"
                  :class="{ number: part.number }"
                  >{{ part.text }}</span
                >
                <footer>
                  {{ state.document.label }}, стр. PDF {{ state.quote.page }} ·
                  <a
                    :href="`${documentPdfUrl(state.document.id)}#page=${state.quote.page}`"
                    target="_blank"
                    rel="noopener"
                    >Открыть PDF</a
                  >
                </footer>
              </blockquote>
              <p v-else class="error">
                Пункт не найден в тексте PDF (возможно, документ отсканирован или нумерация
                изменилась). Проверьте по PDF и опишите в примечании, где указано значение.
              </p>
              <details
                v-if="
                  state.confirmation &&
                  state.status.kind !== 'confirmed' &&
                  state.confirmation.quote
                "
                open
              >
                <summary>
                  Цитата, по которой подтверждено прежде ({{ state.confirmation.documentLabel }})
                </summary>
                <blockquote class="quote old">{{ state.confirmation.quote }}</blockquote>
              </details>
              <p v-if="state.suggestion !== null" class="hint">
                Значение из текста: {{ valueText(definition, state.suggestion) }}.
              </p>
            </template>
          </template>

          <label v-if="definition.type === 'number'"
            >Значение{{ definition.unit ? `, ${definition.unit}` : '' }}
            <input
              v-model="form.number"
              inputmode="decimal"
              maxlength="12"
              :disabled="busy"
              :aria-invalid="fieldInvalid('value')"
              :aria-describedby="fieldInvalid('value') ? 'parameter-confirm-error' : undefined"
            />
          </label>
          <table v-else class="rows">
            <thead>
              <tr>
                <th>{{ definition.keyLabel }}</th>
                <th>{{ definition.valueLabel }}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(row, index) in form.rows" :key="index">
                <td>
                  <input
                    v-model="row.key"
                    maxlength="80"
                    :aria-label="definition.keyLabel"
                    :disabled="busy"
                    :aria-invalid="fieldInvalid('value')"
                  />
                </td>
                <td>
                  <input
                    v-model="row.value"
                    maxlength="20"
                    :aria-label="definition.valueLabel"
                    :disabled="busy"
                    :aria-invalid="fieldInvalid('value')"
                  />
                </td>
                <td>
                  <button type="button" :disabled="busy" @click="form.rows.splice(index, 1)">
                    Удалить
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
          <button
            v-if="definition.type === 'table'"
            type="button"
            :disabled="busy"
            @click="form.rows.push({ key: '', value: '' })"
          >
            Добавить строку
          </button>
          <label
            >{{
              definition.source.kind === 'decision'
                ? 'Основание решения (обязательно)'
                : noteRequired(definition, state)
                  ? 'Примечание: страница и формулировка (обязательно)'
                  : 'Примечание (необязательно)'
            }}
            <textarea
              v-model="form.note"
              rows="2"
              maxlength="2000"
              :required="noteRequired(definition, state)"
              :disabled="busy"
              :aria-invalid="fieldInvalid('note')"
              :aria-describedby="fieldInvalid('note') ? 'parameter-confirm-error' : undefined"
            />
          </label>
          <p v-if="error" id="parameter-confirm-error" role="alert" class="error">{{ error }}</p>
          <button
            type="button"
            class="primary"
            :disabled="
              busy ||
              confirmedBy.trim().length < 2 ||
              (definition.source.kind !== 'decision' && !state?.document)
            "
            @click="confirm(definition, state)"
          >
            Подтвердить значение
          </button>
          <p v-if="confirmedBy.trim().length < 2" class="hint">Укажите, кто подтверждает.</p>
        </div>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.parameters.guided {
  margin: 0;
  padding: 0;
  border: 0;
  box-shadow: none;
}
.parameter-navigation {
  display: flex;
  flex-wrap: wrap;
  align-items: end;
  gap: 0.6rem;
  margin: 1rem 0;
}
.parameter-navigation select {
  max-width: 100%;
}
.parameters {
  margin: 1rem 0;
  padding: 2rem;
  background: #fff;
  border: 1px solid #d8e1eb;
  border-radius: 0.8rem;
}
h2 {
  margin-top: 0;
}
.hint {
  color: #526273;
  line-height: 1.5;
}
.error {
  color: #a22030;
  font-weight: 600;
}
.ok-text {
  color: #1d6b3a;
}
button {
  padding: 0.45rem 0.7rem;
  border: 1px solid #185ca5;
  border-radius: 0.35rem;
  background: #fff;
  color: #185ca5;
  cursor: pointer;
  font: inherit;
}
button.primary {
  background: #185ca5;
  color: #fff;
}
button:disabled {
  opacity: 0.55;
  cursor: default;
}
label {
  display: grid;
  gap: 0.25rem;
  margin: 0.6rem 0;
}
input,
textarea {
  padding: 0.45rem;
  font: inherit;
}
.who {
  max-width: 28rem;
}
.list {
  display: grid;
  gap: 0.8rem;
  padding: 0;
  list-style: none;
}
.list > li {
  padding: 1rem;
  border: 1px solid #d8e1eb;
  border-radius: 0.5rem;
}
.head {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 0.5rem 1rem;
}
.head > div {
  flex: 1 1 22rem;
  min-width: 0;
}
.head small {
  display: block;
  margin-top: 0.2rem;
  color: #526273;
}
.value {
  flex: 0 1 auto;
  max-width: 100%;
  font-weight: 600;
  overflow-wrap: anywhere;
}
.status {
  margin: 0.5rem 0;
  padding: 0.35rem 0.6rem;
  border-left: 3px solid;
}
.status.ok {
  border-color: #1d6b3a;
  background: #eef8f1;
}
.status.notice {
  border-color: #185ca5;
  background: #eef4fb;
}
.status.warn {
  border-color: #b7791f;
  background: #fff8e8;
}
.confirm {
  margin-top: 0.8rem;
}
.quote {
  white-space: pre-line;
  margin: 0.5rem 0;
  padding: 0.7rem 0.9rem;
  border-left: 3px solid #185ca5;
  background: #f6f8fb;
  line-height: 1.5;
}
.quote.old {
  border-color: #93a5b8;
  color: #526273;
}
.quote .number {
  padding: 0 0.1rem;
  background: #ffe58a;
  font-weight: 600;
}
.quote footer {
  margin-top: 0.4rem;
  color: #526273;
  font-size: 0.9rem;
}
.rows {
  border-collapse: collapse;
}
.rows th,
.rows td {
  padding: 0.25rem;
  text-align: left;
}
.rows input {
  width: 100%;
  box-sizing: border-box;
}
</style>
