<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue'
import NormativeDocuments from './NormativeDocuments.vue'
import PdfSignCatalog from './PdfSignCatalog.vue'
import ImportedData from './ImportedData.vue'
import NormativeParameters from './NormativeParameters.vue'
import { listDocuments } from '../services/local-documents'
import {
  documentStatuses,
  normalizeDocumentCode,
  type DocumentRecord,
} from '../domain/normative-documents'
import { parameterDefinitions } from '../domain/normative-parameters'
import { localCalendarDate } from '../domain/pu66-review'
import { ready, type FirstRunStatus } from '../presentation/first-run'

const props = defineProps<{ status: FirstRunStatus; refreshKey: number }>()
const emit = defineEmits<{ refresh: []; finish: []; exit: [] }>()
const step = ref(0)
const heading = ref<HTMLElement | null>(null)
const documents = ref<DocumentRecord[]>([])
const documentError = ref('')
const loading = ref(true)
const help = ref(false)
const busyTasks = ref(new Set<string>())
const busy = computed(() => loading.value || busyTasks.value.size > 0)
const editSignsDocument = ref(false)
const steps = [
  'Дорожные знаки',
  'Карточки переездов',
  'Документы для правил',
  'Подтверждение параметров',
]
const descriptions = [
  'Добавьте ГОСТ Р 52290, затем проверьте и сохраните извлечённые знаки прямо здесь.',
  'Выберите книги ПУ-66, просмотрите изменения и подтвердите импорт. Возвращаться в реестры не нужно.',
  'Добавьте источники правил и действующие изменения к ним. Уже добавленные документы повторно загружать не нужно.',
  'Сверяйте по одному параметру с источником и подтверждайте значение. У каждого решения остаётся своё основание.',
]
const requiredCodes = [
  ...new Set(
    parameterDefinitions.flatMap((d) =>
      d.source.kind === 'decision' ? [] : [normalizeDocumentCode(d.source.documentCode)],
    ),
  ),
]
const currentCodes = computed(() => {
  const statuses = documentStatuses(documents.value, localCalendarDate(new Date()))
  return new Set(
    documents.value
      .filter((d) => statuses.get(d.id)?.kind === 'current')
      .map((d) => normalizeDocumentCode(d.code)),
  )
})
const signDocumentReady = computed(() =>
  documents.value.some(
    (d) =>
      d.kind === 'signs' &&
      normalizeDocumentCode(d.code) === 'ГОСТ Р 52290' &&
      documentStatuses(documents.value, localCalendarDate(new Date())).get(d.id)?.kind ===
        'current',
  ),
)
const missingCodes = computed(() => requiredCodes.filter((code) => !currentCodes.value.has(code)))
const stageReady = computed(() => [
  !documentError.value && signDocumentReady.value && props.status.signs > 0,
  props.status.cards > 0,
  !documentError.value && missingCodes.value.length === 0,
  !props.status.parametersError && ready(props.status.parameters) && ready(props.status.pdd),
])
const complete = computed(() => stageReady.value.every(Boolean))
const reasons = computed(() => [
  !signDocumentReady.value
    ? 'Сначала добавьте действующий ГОСТ Р 52290 с датой введения.'
    : 'Сначала проверьте и запишите каталог знаков.',
  'Сначала запишите хотя бы одну действующую карточку ПУ-66.',
  `Добавьте действующие документы: ${missingCodes.value.join(', ')}.`,
  props.status.parametersError
    ? 'Не удалось проверить параметры. Повторите загрузку в этом шаге.'
    : 'Подтвердите оставшиеся параметры по источникам. Нажатие «Далее» их не подтверждает.',
])
function setBusy(key: string, value: boolean): void {
  const next = new Set(busyTasks.value)
  if (value) next.add(key)
  else next.delete(key)
  busyTasks.value = next
}
async function reloadDocuments(): Promise<void> {
  loading.value = true
  try {
    documents.value = await listDocuments()
    documentError.value = ''
  } catch {
    documentError.value = 'Не удалось прочитать документы. Повторите загрузку.'
  } finally {
    loading.value = false
  }
}
async function changed(): Promise<void> {
  emit('refresh')
  await reloadDocuments()
}
async function move(target: number): Promise<void> {
  if (busy.value || target < 0 || target >= steps.length) return
  if (target > step.value && !stageReady.value[step.value]) return
  step.value = target
  await nextTick()
  heading.value?.focus()
}
function finish(): void {
  if (!busy.value && complete.value) emit('finish')
}
onMounted(async () => {
  await reloadDocuments()
  const firstMissing = stageReady.value.findIndex((value) => !value)
  step.value = firstMissing < 0 ? 3 : firstMissing
})
</script>

<template>
  <section
    class="setup-workspace"
    data-testid="setup-workspace"
    aria-labelledby="setup-workspace-title"
  >
    <header class="setup-intro">
      <div>
        <p class="setup-eyebrow">Подготовка рабочего места</p>
        <h1 id="setup-workspace-title">Настройка программы</h1>
        <p>Четыре шага — всё необходимое для первой схемы.</p>
      </div>
      <button type="button" class="setup-exit" :disabled="busy" @click="emit('exit')">
        Продолжить позже
      </button>
    </header>
    <div class="setup-layout">
      <nav class="setup-route" aria-label="Шаги настройки">
        <ol>
          <li
            v-for="(title, index) in steps"
            :key="title"
            :aria-current="step === index ? 'step' : undefined"
            :data-ready="stageReady[index]"
          >
            <span class="setup-number">{{ stageReady[index] ? '✓' : index + 1 }}</span>
            <div>
              <strong>{{ title }}</strong
              ><small>{{
                stageReady[index] ? 'Готово' : step === index ? 'Текущий шаг' : 'Предстоит'
              }}</small>
            </div>
          </li>
        </ol>
        <button type="button" class="setup-help" :aria-expanded="help" @click="help = !help">
          Нужна подсказка
        </button>
        <p v-if="help" class="setup-help-text">
          Выбирайте файлы и подтверждайте запись внутри шага. «Назад» сохраняет ввод, «Далее»
          открывает следующий шаг после готовности. Файлы остаются на этом компьютере. «Продолжить
          позже» открывает обычное рабочее место; вернуться можно кнопкой «Продолжить настройку».
        </p>
      </nav>
      <div class="setup-body">
        <h2 ref="heading" tabindex="-1">{{ step + 1 }}. {{ steps[step] }}</h2>
        <p class="setup-description">{{ descriptions[step] }}</p>
        <p v-if="documentError" class="setup-error" role="alert">
          {{ documentError }}
          <button type="button" @click="reloadDocuments">Повторить загрузку документов</button>
        </p>
        <p v-if="loading" role="status">Читаем готовность документов…</p>
        <section v-show="step === 0" aria-label="Подготовка знаков">
          <p v-if="signDocumentReady" class="setup-success" role="status">
            ГОСТ Р 52290 добавлен. Знаков в каталоге: {{ status.signs }}.
          </p>
          <button
            v-if="signDocumentReady"
            type="button"
            :disabled="busy"
            @click="editSignsDocument = !editSignsDocument"
          >
            {{ editSignsDocument ? 'Скрыть добавление ГОСТ' : 'Добавить другую версию ГОСТ' }}
          </button>
          <div v-show="!signDocumentReady || editSignsDocument">
            <NormativeDocuments
              guided
              heading-id="setup-sign-document-title"
              file-label="Файл ГОСТ Р 52290 (PDF)"
              @changed="changed"
              @busy="setBusy('sign-document', $event)"
            />
          </div>
          <PdfSignCatalog
            v-if="signDocumentReady"
            :documents="documents.filter((d) => normalizeDocumentCode(d.code) === 'ГОСТ Р 52290')"
            :locked="false"
            @applied="changed"
            @busy="setBusy('extraction', $event)"
          />
        </section>
        <section v-show="step === 1" aria-label="Подготовка карточек">
          <p class="setup-success" role="status">Действующих карточек: {{ status.cards }}.</p>
          <ImportedData
            guided
            :referenced-sign-ids="[]"
            :locked="false"
            :refresh-key="refreshKey"
            @pu66-updated="emit('refresh')"
            @busy="setBusy('cards', $event)"
          />
        </section>
        <section v-show="step === 2" aria-label="Подготовка документов">
          <ul class="setup-sources">
            <li v-for="code in requiredCodes" :key="code">
              <span>{{ currentCodes.has(code) ? '✓' : '○' }}</span> {{ code }} —
              {{ currentCodes.has(code) ? 'добавлен' : 'нужен документ' }}
            </li>
          </ul>
          <NormativeDocuments
            guided
            heading-id="setup-rule-document-title"
            @changed="changed"
            @busy="setBusy('rule-documents', $event)"
          />
        </section>
        <section v-show="step === 3" aria-label="Подготовка параметров">
          <p v-if="!status.parametersError" class="setup-success" role="status">
            Подтверждено {{ status.parameters.confirmed }} из {{ status.parameters.total }} · ПДД:
            {{ status.pdd.confirmed }} из {{ status.pdd.total }}.
          </p>
          <NormativeParameters
            guided
            :refresh-key="refreshKey"
            @busy="setBusy('parameters', $event)"
          />
        </section>
      </div>
    </div>
    <footer class="setup-footer">
      <p role="status">
        {{
          busy
            ? 'Дождитесь завершения действия…'
            : stageReady[step]
              ? 'Шаг готов. Можно продолжать.'
              : reasons[step]
        }}
      </p>
      <div>
        <button type="button" :disabled="busy || step === 0" @click="move(step - 1)">Назад</button
        ><button
          v-if="step < 3"
          type="button"
          class="setup-primary"
          :disabled="busy || !stageReady[step]"
          @click="move(step + 1)"
        >
          Далее</button
        ><button
          v-else
          type="button"
          class="setup-primary"
          :disabled="busy || !complete"
          @click="finish"
        >
          Завершить настройку
        </button>
      </div>
    </footer>
  </section>
</template>
<style scoped src="../styles/SetupWorkspace.css" />
