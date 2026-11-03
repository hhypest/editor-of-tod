<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { Scheme } from '../domain/model'
import { useNormativeRules } from '../composables/useNormativeRules'
import {
  junctionWarningReason,
  prepareJunctionWarnings,
  applyJunctionWarnings,
  junctionWarningsHaveChanges,
  JunctionWarningError,
  type JunctionWarningPlan,
  type JunctionWarningChoices,
} from '../domain/junction-warning-proposals'
const props = defineProps<{ scheme: Scheme; locked: boolean }>()
const emit = defineEmits<{ apply: [scheme: Scheme] }>()
const { rules, loading, error: parameterError } = useNormativeRules()
const nodes = computed(() =>
  props.scheme.roadLayout.nodes.filter((node) => node.kind === 'junction'),
)
const selected = ref<number[]>([]),
  plan = ref<JunctionWarningPlan | null>(null),
  choices = ref<JunctionWarningChoices>({}),
  error = ref(''),
  status = ref('')
const blocked = computed(() => props.locked || loading.value || Boolean(parameterError.value))
const range = computed(
  () =>
    rules.value.parameterBasis[
      props.scheme.parameters.location === 'in'
        ? 'project-junction-range-in'
        : 'project-junction-range-out'
    ],
)
watch([() => props.scheme, range], () => {
  plan.value = null
  choices.value = {}
  status.value = ''
  selected.value = selected.value.filter((id) =>
    nodes.value.some(
      (node) => node.id === id && !junctionWarningReason(props.scheme, node, rules.value),
    ),
  )
})
function select(id: number, event: Event) {
  if (blocked.value) return
  selected.value = (event.target as HTMLInputElement).checked
    ? [...selected.value, id]
    : selected.value.filter((value) => value !== id)
  close()
  error.value = ''
  status.value = ''
}
function close() {
  plan.value = null
  choices.value = {}
}
function prepare() {
  if (blocked.value) return
  try {
    plan.value = prepareJunctionWarnings(props.scheme, selected.value, rules.value)
    choices.value = {}
    error.value = ''
    status.value = ''
  } catch (cause) {
    error.value =
      cause instanceof JunctionWarningError
        ? cause.message
        : 'Не удалось подготовить предупреждающие стойки.'
  }
}
function apply() {
  if (blocked.value || !plan.value) return
  try {
    const result = applyJunctionWarnings(props.scheme, plan.value, choices.value, rules.value)
    close()
    error.value = ''
    emit('apply', result)
    status.value =
      'Предложения применены одним действием. Проверьте замеры установки и компоновку листа.'
  } catch (cause) {
    error.value =
      cause instanceof JunctionWarningError ? cause.message : 'Не удалось применить предложения.'
  }
}
const labels = {
  create: 'Будет создана',
  update: 'Расчётный вариант обновится',
  unchanged: 'Без изменений',
  modified: 'Изменена вручную',
  excluded: 'Остаётся исключённой',
}
</script>

<template>
  <section v-if="nodes.length" data-junction-warning-proposals>
    <h3>Предупреждающие стойки примыканий</h3>
    <p>
      Для обычной дороги сначала сохраните запрос предупреждающего знака в свойствах узла. Здесь
      можно просмотреть стойку 1.25 с табличкой направления. Основание — решения Д2, Д3 и Д9 от
      01.11.2026: значение таблички равно d от L0/E до оси узла. Замер установки задаётся отдельно в
      свойствах стойки.
    </p>
    <p v-if="range">
      Граница включения: {{ range.value }} м, включительно. {{ range.source }}.
      {{
        range.confirmed
          ? 'Параметр подтверждён.'
          : 'Параметр не подтверждён: используется предварительное значение.'
      }}
    </p>
    <p>
      Это предложение состава и условного рисунка. Расстояние 50–60 м не назначается автоматически.
      Повторы на основной дороге и полный выпуск П6 требуют завершения отдельного расчёта.
    </p>
    <p v-if="parameterError" role="alert">{{ parameterError }}</p>
    <fieldset :disabled="blocked">
      <legend>Примыкания для просмотра</legend>
      <label v-for="node in nodes" :key="node.id">
        <input
          type="checkbox"
          :checked="selected.includes(node.id)"
          :disabled="Boolean(junctionWarningReason(scheme, node, rules))"
          @change="select(node.id, $event)"
        />
        Узел № {{ node.id }} — {{ node.name || 'без названия' }}, {{ node.position.metres }} м от
        {{ node.position.from }}
        <span v-if="junctionWarningReason(scheme, node, rules)" class="reason">{{
          junctionWarningReason(scheme, node, rules)
        }}</span>
      </label>
      <button type="button" :disabled="!selected.length" @click="prepare">
        Подготовить предупреждающие стойки
      </button>
    </fieldset>
    <div v-if="plan">
      <p>
        До применения проект остаётся прежним. Ручные правки и исключения сохраняются по умолчанию.
      </p>
      <ul>
        <li v-for="item in plan.items" :key="item.nodeId" :data-junction-warning="item.nodeId">
          <strong>Узел № {{ item.nodeId }} — стойка № {{ item.post.id }}</strong>
          <p>
            {{ labels[item.kind] }}. Предложение: {{ item.post.signIds.join(', ') }};
            {{ item.link.branchPlacement!.branch === 'up' ? 'верхняя' : 'нижняя' }} ветвь, поворот
            {{ item.link.branchPlacement!.rotation }}°; замер не задан.
          </p>
          <p v-if="item.current">
            Сохранено: {{ item.current.post.signIds.join(', ') }};
            {{
              item.current.link.installation
                ? `${item.current.link.installation.metres} м от ${item.current.link.installation.from === 'node-axis' ? 'оси узла' : item.current.link.installation.from}`
                : 'замер не задан'
            }};
            {{
              item.current.link.branchPlacement
                ? `отступ вдоль ${item.current.link.branchPlacement.alongSvg}, поперёк ${item.current.link.branchPlacement.acrossSvg} усл. ед.; поворот ${item.current.link.branchPlacement.rotation}°`
                : 'положение на основной дороге'
            }}.
          </p>
          <p v-if="item.current?.link.calculation?.ruleId === 'project-junction-warning-v1'">
            Прежнее основание: Д3/Д9, d = {{ item.current.link.calculation.nodePosition.metres }} м
            от {{ item.current.link.calculation.nodePosition.from }},
            {{ item.current.link.calculation.sourceSignIds.join(', ') }}; граница
            {{ item.current.link.calculation.rangeBasis.value }} м,
            {{
              item.current.link.calculation.rangeBasis.confirmed
                ? 'подтверждена'
                : 'не подтверждена'
            }}.
          </p>
          <p>
            Новое основание: Д3/Д9, d = {{ item.link.calculation!.nodePosition.metres }} м от
            {{ item.link.calculation!.nodePosition.from }},
            {{ item.link.calculation!.sourceSignIds.join(', ') }}; граница {{ range?.value }} м,
            {{ range?.confirmed ? 'подтверждена' : 'не подтверждена' }}.
          </p>
          <label v-if="item.kind === 'modified' || item.kind === 'excluded'"
            >Решение для узла № {{ item.nodeId }}
            <select
              :value="choices[item.nodeId] ?? 'keep'"
              :disabled="blocked"
              @change="
                choices[item.nodeId] = ($event.target as HTMLSelectElement).value as
                  'keep' | 'accept' | 'restore'
              "
            >
              <option value="keep">
                {{ item.kind === 'modified' ? 'Оставить своё' : 'Оставить исключённой' }}
              </option>
              <option v-if="item.kind === 'modified'" value="accept">Принять предложение</option>
              <option v-else value="restore">Восстановить предложенный вариант</option>
            </select>
          </label>
        </li>
      </ul>
      <button
        type="button"
        :disabled="blocked || !junctionWarningsHaveChanges(plan, choices)"
        @click="apply"
      >
        Применить предупреждающие стойки
      </button>
      <button type="button" @click="close">Закрыть предложения</button>
    </div>
    <p v-if="error" role="alert">{{ error }}</p>
    <p v-if="status" role="status">{{ status }}</p>
  </section>
</template>

<style scoped>
p,
.reason {
  line-height: 1.5;
  color: #526273;
  overflow-wrap: anywhere;
}
fieldset {
  border: 1px solid #c8d1df;
  padding: 1rem;
  min-width: 0;
}
label,
.reason {
  display: block;
  margin: 0.5rem 0;
}
li {
  border-bottom: 1px solid #c8d1df;
  padding: 0.8rem 0;
}
button,
select {
  font: inherit;
  padding: 0.5rem 0.7rem;
  margin: 0.4rem;
  max-width: 100%;
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
