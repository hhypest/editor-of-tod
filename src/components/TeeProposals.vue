<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { Scheme } from '../domain/model'
import {
  teeSourcePosts,
  prepareTeeProposals,
  applyTeeProposals,
  teeProposalsHaveChanges,
  teeSourcesToExclude,
  TeeProposalError,
  type TeeProposalPlan,
  type TeeProposalChoices,
} from '../domain/tee-proposals'
const props = defineProps<{ scheme: Scheme; locked: boolean }>()
const emit = defineEmits<{ apply: [scheme: Scheme] }>()
const sources = computed(() => teeSourcePosts(props.scheme))
const selected = ref<number[]>([]),
  plan = ref<TeeProposalPlan | null>(null),
  choices = ref<TeeProposalChoices>({}),
  error = ref(''),
  status = ref('')
const labels = {
  create: 'Будет создана',
  update: 'Расчётный вариант обновится',
  unchanged: 'Без изменений',
  modified: 'Изменена вручную',
  excluded: 'Остаётся исключённой',
}
watch(
  () => props.scheme,
  () => {
    plan.value = null
    choices.value = {}
    selected.value = selected.value.filter((id) => sources.value.some((p) => p.post.id === id))
  },
)
function select(id: number, event: Event) {
  if (props.locked) return
  selected.value = (event.target as HTMLInputElement).checked
    ? [...selected.value, id]
    : selected.value.filter((value) => value !== id)
  plan.value = null
  choices.value = {}
  error.value = ''
  status.value = ''
}
function prepare() {
  if (props.locked) return
  try {
    plan.value = prepareTeeProposals(props.scheme, selected.value)
    choices.value = {}
    error.value = ''
    status.value = ''
  } catch (cause) {
    error.value =
      cause instanceof TeeProposalError ? cause.message : 'Не удалось подготовить предложения.'
  }
}
function close() {
  plan.value = null
  choices.value = {}
}
function apply() {
  if (props.locked || !plan.value) return
  try {
    const result = applyTeeProposals(props.scheme, plan.value, choices.value)
    plan.value = null
    error.value = ''
    status.value = 'Предложения применены одним действием. Проверьте замеры и положение на листе.'
    emit('apply', result)
  } catch (cause) {
    error.value =
      cause instanceof TeeProposalError ? cause.message : 'Не удалось применить предложения.'
  }
}
</script>
<template>
  <section v-if="sources.length" data-tee-proposals>
    <h3>Предложения для Т-перекрёстка</h3>
    <p>
      Выберите исходные стойки для переноса на обе ветви. Основание — согласованное решение Д4 от
      01.11.2026. Знаки копируются из выбранной стойки; исходная стойка сохраняется в исключённых.
      Условное место и поворот — предложение раскладки. Замер установки на ветви нужно заполнить
      отдельно после сверки.
    </p>
    <fieldset :disabled="locked">
      <legend>Исходные стойки для переноса</legend>
      <label v-for="item in sources" :key="item.post.id" class="check">
        <input
          type="checkbox"
          :checked="selected.includes(item.post.id)"
          @change="select(item.post.id, $event)"
        />
        Стойка № {{ item.post.id }} — {{ item.post.signIds.join(', ') }}
        {{ item.excluded ? '(сохранена в исключённых)' : '' }}
      </label>
      <button type="button" :disabled="!selected.length" @click="prepare">
        Подготовить предложения
      </button>
    </fieldset>
    <div v-if="plan" class="plan">
      <p v-if="teeSourcesToExclude(plan, choices).length">
        Будут сохранены в исключённых исходные стойки №
        {{ teeSourcesToExclude(plan, choices).join(', ') }}.
      </p>
      <p>
        До применения проект остаётся прежним. Ручные изменения и исключения сохраняются по
        умолчанию. Если проект изменится, предложения потребуется подготовить заново.
      </p>
      <ul>
        <li v-for="item in plan.items" :key="item.key" :data-tee-proposal="item.key">
          <strong
            >Стойка № {{ item.post.id }} —
            {{ item.branch === 'up' ? 'верхняя' : 'нижняя' }} ветвь</strong
          >
          <p>{{ labels[item.kind] }}. Исходная стойка № {{ item.sourceId }}.</p>
          <p v-if="item.current?.link.calculation">
            Прежнее основание: Д4, знаки исходной стойки
            {{ item.current.link.calculation.sourceSignIds.join(', ') }}; узел
            {{ item.current.link.calculation.nodePosition.metres }} м от
            {{ item.current.link.calculation.nodePosition.from }}.
          </p>
          <p>
            Новое основание: Д4, знаки исходной стойки
            {{ item.link.calculation!.sourceSignIds.join(', ') }}; узел
            {{ item.link.calculation!.nodePosition.metres }} м от
            {{ item.link.calculation!.nodePosition.from }}.
          </p>
          <p>
            Предложение: {{ item.post.signIds.join(', ') }}; отступ вдоль
            {{ item.link.branchPlacement!.alongSvg }}, поперёк
            {{ item.link.branchPlacement!.acrossSvg }} усл. ед.; поворот
            {{ item.link.branchPlacement!.rotation }}°; замер не задан.
          </p>
          <p v-if="item.current">
            Сохранено: {{ item.current.post.signIds.join(', ') }};
            {{
              item.current.link.branchPlacement
                ? `отступ вдоль ${item.current.link.branchPlacement.alongSvg}, поперёк ${item.current.link.branchPlacement.acrossSvg} усл. ед.; поворот ${item.current.link.branchPlacement.rotation}°`
                : 'положение на основной дороге'
            }};
            {{
              item.current.link.installation
                ? `${item.current.link.installation.metres} м от ${item.current.link.installation.from === 'node-axis' ? 'оси узла' : item.current.link.installation.from}`
                : 'замер не задан'
            }}.
          </p>
          <label v-if="item.kind === 'modified' || item.kind === 'excluded'"
            >Решение для стойки № {{ item.post.id }}
            <select
              :value="choices[item.key] ?? 'keep'"
              :disabled="locked"
              @change="
                choices[item.key] = ($event.target as HTMLSelectElement).value as
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
        :disabled="locked || !teeProposalsHaveChanges(plan, choices)"
        @click="apply"
      >
        Применить предложения
      </button>
      <button type="button" @click="close">Закрыть предложения</button>
    </div>
    <p v-if="error" role="alert">{{ error }}</p>
    <p v-if="status" role="status">{{ status }}</p>
  </section>
</template>
<style scoped>
p {
  line-height: 1.5;
  color: #526273;
}
fieldset {
  border: 1px solid #c8d1df;
  padding: 1rem;
}
label {
  display: block;
  margin: 0.5rem 0;
}
li {
  border-bottom: 1px solid #c8d1df;
  padding: 0.8rem 0;
}
li p {
  margin: 0.4rem 0;
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
