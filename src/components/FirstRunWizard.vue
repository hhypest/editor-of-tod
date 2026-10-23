<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ready, type FirstRunStatus } from '../presentation/first-run'
import type { SetupImportTarget } from '../presentation/editor-navigation'

const props = defineProps<{ status: FirstRunStatus }>()
const emit = defineEmits<{
  navigate: [target: SetupImportTarget]
  help: []
}>()

const step = ref(0)
const collapsed = ref(false)
let initialized = false
const steps = [
  { id: 'signs', title: 'Знаки из PDF', action: 'Извлечь знаки из PDF' },
  { id: 'cards', title: 'Книги ПУ-66', action: 'Импортировать книги ПУ-66' },
  { id: 'parameters', title: 'Нормативные параметры', action: 'Проверить параметры' },
] as const

const signsReady = computed(() => props.status.signs > 0)
const cardsReady = computed(() => props.status.cards > 0)
const parametersReady = computed(() => ready(props.status.parameters))
const complete = computed(() => signsReady.value && cardsReady.value && parametersReady.value)
const stepReady = computed(() => [signsReady.value, cardsReady.value, parametersReady.value])
const showWizard = computed(() => !complete.value || !collapsed.value)

watch(
  () => props.status,
  (status) => {
    if (!initialized) {
      step.value = !signsReady.value ? 0 : !cardsReady.value ? 1 : 2
      initialized = true
    } else if (step.value < 2 && stepReady.value[step.value]) {
      step.value++
    }
    if (ready(status.parameters) && signsReady.value && cardsReady.value) collapsed.value = true
  },
  { immediate: true },
)

function next(): void {
  if (!stepReady.value[step.value]) return
  if (step.value < 2) step.value++
  else collapsed.value = true
}

function targetForStep(): SetupImportTarget {
  return step.value === 0 ? 'pdf-sign-import' : 'pu66-import'
}
</script>

<template>
  <section
    class="setup-guide module"
    :class="{ 'setup-complete': complete && !showWizard }"
    aria-labelledby="setup-heading"
    data-testid="first-run-wizard"
  >
    <template v-if="showWizard">
      <p class="eyebrow">Первый запуск · база на этом компьютере готова</p>
      <h2 id="setup-heading">Настройте программу за 3 шага</h2>
      <p>
        Выполняйте шаги по порядку. После каждого действия возвращайтесь в «Проекты»: мастер покажет
        результат и откроет следующий шаг.
      </p>
      <ol class="setup-progress" aria-label="Этапы первоначальной настройки">
        <li
          v-for="(item, index) in steps"
          :key="item.id"
          :aria-current="step === index ? 'step' : undefined"
          :data-ready="stepReady[index]"
        >
          <span>Шаг {{ index + 1 }}</span>
          <strong>{{ item.title }}</strong>
          <small>{{
            stepReady[index] ? 'Готово' : step === index ? 'Текущий шаг' : 'После предыдущего шага'
          }}</small>
        </li>
      </ol>

      <section v-if="step === 0" class="setup-step" aria-labelledby="setup-signs">
        <h3 id="setup-signs">1. Добавьте дорожные знаки</h3>
        <p>
          Прикрепите PDF ГОСТ Р 52290 и извлеките из него знаки. Проверьте предложенный список и
          подтвердите запись — программа создаст резервную копию.
        </p>
        <p class="setup-readiness" role="status">
          {{ signsReady ? `Готово: ${status.signs} знаков в базе.` : 'Пока нет знаков в базе.' }}
        </p>
        <div class="setup-actions">
          <button type="button" @click="emit('navigate', 'normative-documents')">
            Добавить ГОСТ Р 52290
          </button>
          <button type="button" @click="emit('navigate', targetForStep())">
            {{ steps[0].action }}
          </button>
        </div>
      </section>

      <section v-else-if="step === 1" class="setup-step" aria-labelledby="setup-cards">
        <h3 id="setup-cards">2. Импортируйте карточки переездов</h3>
        <p>
          Выберите разрешённые книги ПУ-66 в формате XLSX — можно сразу до 100 файлов. Просмотрите
          изменения и подтвердите импорт. Без карточки новый проект создать нельзя.
        </p>
        <p class="setup-readiness" role="status">
          {{ cardsReady ? `Готово: ${status.cards} карточек в базе.` : 'Пока нет карточек ПУ-66.' }}
        </p>
        <button type="button" @click="emit('navigate', targetForStep())">
          {{ steps[1].action }}
        </button>
        <p class="hint">
          Импорт не отмечает ежегодную сверку ПУ-66; её регистрирует линейное подразделение после
          фактической проверки.
        </p>
      </section>

      <section v-else class="setup-step" aria-labelledby="setup-parameters">
        <h3 id="setup-parameters">3. Подтвердите нормативные параметры</h3>
        <p>
          Добавьте действующие версии ОДМ, ГОСТ и ПДД. Затем откройте каждый параметр, сверьте
          значение с цитатой и подтвердите его. У ПДД отдельно укажите дату введения версии.
        </p>
        <p class="setup-readiness" role="status">
          Подтверждено {{ status.parameters.confirmed }} из {{ status.parameters.total }} · ПДД:
          {{ status.pdd.confirmed }} из {{ status.pdd.total }}.
        </p>
        <div class="setup-actions">
          <button type="button" @click="emit('navigate', 'normative-documents')">
            Добавить нормативные документы
          </button>
          <button type="button" @click="emit('navigate', 'normative-parameters')">
            {{ steps[2].action }}
          </button>
        </div>
      </section>

      <div class="setup-navigation">
        <button type="button" :disabled="step === 0" @click="step--">Назад</button>
        <button type="button" :disabled="!stepReady[step]" @click="next">
          {{ step === 2 ? 'Завершить настройку' : 'Далее' }}
        </button>
        <button type="button" class="link-button" @click="emit('help')">Нужна подсказка</button>
      </div>
    </template>

    <div v-else class="setup-summary">
      <strong id="setup-heading">Настройка завершена</strong>
      <span>
        Знаков: {{ status.signs }} · карточек ПУ-66: {{ status.cards }} · параметров:
        {{ status.parameters.confirmed }} из {{ status.parameters.total }}.
      </span>
      <button type="button" class="link-button" @click="collapsed = false">
        Проверить настройку
      </button>
    </div>
  </section>
</template>

<style scoped src="../styles/FirstRunWizard.css" />
