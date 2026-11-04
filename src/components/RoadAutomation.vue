<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { Scheme } from '../domain/model'
import { useNormativeRules } from '../composables/useNormativeRules'
import {
  prepareRoadAutomation,
  applyRoadAutomation,
  type RoadPlan,
  type RoadChoices,
} from '../domain/road-automation'
import { roadAutomationCurrent } from '../domain/road-automation-state'
import { legacyRoadLayoutProblem } from '../domain/legacy-road-layout'
import { roadValuesEqual } from '../domain/road-calculation-state'
const props = defineProps<{ scheme: Scheme; locked: boolean }>()
const emit = defineEmits<{ apply: [scheme: Scheme] }>()
const { rules, loading, error: parameterError } = useNormativeRules()
const plan = ref<RoadPlan | null>(null),
  choices = ref<RoadChoices>({}),
  error = ref(''),
  status = ref('')
const visible = computed(
  () =>
    props.scheme.roadLayout.nodes.length ||
    props.scheme.roadLayout.automation ||
    legacyRoadLayoutProblem(props.scheme.source),
)
const blocked = computed(() => props.locked || loading.value || Boolean(parameterError.value))
const labels = {
  create: 'Будет создана',
  update: 'Расчёт обновится',
  unchanged: 'Без изменений',
  modified: 'Изменена вручную',
  excluded: 'Остаётся исключённой',
  manual: 'Сохранена прежняя ручная стойка',
}
const changes = computed(
  () =>
    plan.value &&
    (!roadAutomationCurrent(props.scheme) ||
      !roadValuesEqual(
        props.scheme.roadLayout.automation?.profile,
        Object.values(rules.value.parameterBasis),
      ) ||
      plan.value.rows.some((row) => ['create', 'update'].includes(row.kind)) ||
      Object.values(choices.value).some((value) => value !== 'keep')),
)
watch([() => props.scheme, rules], () => {
  plan.value = null
  choices.value = {}
  status.value = ''
  error.value = ''
})
function prepare() {
  if (blocked.value) return
  try {
    plan.value = prepareRoadAutomation(props.scheme, rules.value)
    choices.value = {}
    error.value = ''
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'Не удалось подготовить план.'
  }
}
function close() {
  plan.value = null
  choices.value = {}
}
function apply() {
  if (blocked.value || !plan.value) return
  try {
    const result = applyRoadAutomation(props.scheme, plan.value, choices.value, rules.value)
    close()
    emit('apply', result)
    status.value =
      'Основная схема и примыкания применены одной операцией. Проверьте лист и предупреждения.'
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'Не удалось применить план.'
  }
}
</script>
<template>
  <section v-if="visible" data-road-automation>
    <h3>Полный план расстановки примыканий</h3>
    <p>
      План собирает основную схему, повторы после примыканий и перенос на обе ветви Т-перекрёстка.
      Место узла, установка стойки и значение таблички независимы. Применяется профиль проекта,
      согласованный 04.11.2026; значения и подтверждения доступны в нормативных параметрах.
    </p>
    <p>
      Ручные изменения и исключения сохраняются по умолчанию. Исходные стойки за tee сохраняются в
      исключённых. До применения проект остаётся прежним; после изменения исходных данных план нужно
      подготовить заново.
    </p>
    <p v-if="parameterError" role="alert">{{ parameterError }}</p>
    <button type="button" :disabled="blocked" @click="prepare">Подготовить полный план</button>
    <div v-if="plan">
      <p>
        Типовых объектов основной схемы: {{ plan.baseCount }}. Исходные стойки, сохраняемые в
        исключённых: {{ plan.hiddenIds.join(', ') || 'нет' }}.
      </p>
      <ul v-if="plan.warnings.length">
        <li v-for="warning in plan.warnings" :key="warning">{{ warning }}</li>
      </ul>
      <ul>
        <li v-for="row in plan.rows" :key="row.key" :data-road-plan-row="row.key">
          <strong>Узел № {{ row.nodeId }} — стойка № {{ row.id }}. {{ labels[row.kind] }}</strong>
          <p>
            Предложение: {{ row.signIds.join(', ') }}; установка
            {{ row.link.installation?.metres ?? 'не задана' }} м от
            {{
              row.link.installation?.from === 'node-axis'
                ? 'оси узла'
                : row.link.installation?.from
            }}.
          </p>
          <p v-if="row.current">
            Сохранено: {{ row.current.post.signIds.join(', ') }}; установка
            {{ row.current.link.installation?.metres ?? 'не задана' }};
            {{
              row.current.link.calculation?.state === 'modified'
                ? 'ручная правка'
                : 'прежний вариант'
            }}. Прежнее основание: d={{
              row.current.link.calculation?.nodePosition.metres ?? 'не записано'
            }}. Новое: d={{ row.link.calculation?.nodePosition.metres }}.
          </p>
          <label v-if="['modified', 'excluded', 'manual'].includes(row.kind)"
            >Решение {{ row.key }}
            <select
              :value="choices[row.key] ?? 'keep'"
              :disabled="blocked"
              @change="
                choices[row.key] = ($event.target as HTMLSelectElement).value as
                  'keep' | 'accept' | 'restore'
              "
            >
              <option value="keep">
                {{ row.kind === 'excluded' ? 'Оставить исключённой' : 'Оставить своё' }}
              </option>
              <option v-if="row.kind === 'excluded'" value="restore">
                Восстановить расчётный вариант
              </option>
              <option v-else value="accept">Принять расчётный вариант</option>
            </select>
          </label>
        </li>
      </ul>
      <button type="button" :disabled="blocked || !changes" @click="apply">
        Применить полный план
      </button>
      <button type="button" @click="close">Закрыть полный план</button>
    </div>
    <p v-if="error" role="alert">{{ error }}</p>
    <p v-if="status" role="status">{{ status }}</p>
  </section>
</template>
<style scoped>
p,
li {
  line-height: 1.5;
  overflow-wrap: anywhere;
}
li {
  margin: 0.8rem 0;
}
button,
select {
  font: inherit;
  max-width: 100%;
  padding: 0.5rem;
  margin: 0.4rem;
}
select {
  display: block;
}
[role='alert'] {
  color: #a22030;
}
:focus-visible {
  outline: 3px solid #185ca5;
  outline-offset: 2px;
}
</style>
