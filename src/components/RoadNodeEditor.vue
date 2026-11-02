<script setup lang="ts">
import { computed, ref, watch, useId } from 'vue'
import type { Scheme } from '../domain/model'
import {
  createRoadNodeDraft,
  newRoadNodeDraft,
  saveRoadNode,
  removeRoadNode,
  RoadNodeEditError,
  LINKED_ROAD_NODE_DELETE_PROBLEM,
} from '../domain/edit-road-nodes'
import type { RoadNodeDraft } from '../domain/road-node-draft'
import { legacyRoadLayoutProblem } from '../domain/legacy-road-layout'
import RoadLayoutSummary from './RoadLayoutSummary.vue'

const props = defineProps<{
  scheme: Scheme
  locked?: boolean
  selectedNodeId: number | null
  recovery?: { roadNode?: RoadNodeDraft | null } | null
}>()
const emit = defineEmits<{
  apply: [scheme: Scheme]
  dirty: [value: boolean]
  draft: [value: RoadNodeDraft | null]
  select: [id: number | null]
}>()
const titleId = useId()
const selectedId = ref(props.selectedNodeId)
const initial = props.scheme.roadLayout.nodes.find((node) => node.id === selectedId.value)
const draft = ref<RoadNodeDraft | null>(initial ? createRoadNodeDraft(initial) : null)
const dirty = ref(false)
const error = ref('')
const status = ref('')
const legacyGeometry = computed(() => legacyRoadLayoutProblem(props.scheme.source) !== null)
const hasTee = computed(() =>
  props.scheme.roadLayout.nodes.some((node) => node.kind === 'terminal-tee'),
)
const linkCount = computed(
  () =>
    props.scheme.roadLayout.links.filter((link) => link.nodeId === selectedId.value).length +
    (props.scheme.roadObjectExclusions?.objects.filter(
      (item) => item.link.nodeId === selectedId.value,
    ).length ?? 0),
)

watch(dirty, (value) => emit('dirty', value), { flush: 'sync' })
watch(
  [draft, dirty],
  () => emit('draft', dirty.value && draft.value ? JSON.parse(JSON.stringify(draft.value)) : null),
  { deep: true, flush: 'post' },
)
watch(
  () => props.scheme,
  (scheme) => {
    const selected = scheme.roadLayout.nodes.find((node) => node.id === selectedId.value)
    selectedId.value = selected?.id ?? null
    draft.value = selected ? createRoadNodeDraft(selected) : null
    dirty.value = false
    error.value = ''
    if (selectedId.value !== props.selectedNodeId) emit('select', selectedId.value)
  },
)
watch(
  () => props.recovery,
  (recovery) => {
    if (!recovery?.roadNode) return
    draft.value = JSON.parse(JSON.stringify(recovery.roadNode))
    if (draft.value && draft.value.sheetOffsetXSvg === undefined) {
      const saved = props.scheme.roadLayout.nodes.find((node) => node.id === draft.value?.id)
      draft.value.sheetOffsetXSvg =
        saved?.sheetOffsetXSvg == null ? '' : String(saved.sheetOffsetXSvg)
    }
    selectedId.value = recovery.roadNode.id
    emit('select', selectedId.value)
    dirty.value = true
  },
  { immediate: true },
)
watch(
  () => props.selectedNodeId,
  (id) => {
    if (id === selectedId.value || dirty.value) return
    if (id === null) {
      selectedId.value = null
      draft.value = null
    } else selectNode(id)
  },
)

function markDirty() {
  if (props.locked) return
  dirty.value = true
  error.value = ''
  status.value = ''
}
function selectNode(id: number) {
  if (dirty.value || props.locked) return
  const node = props.scheme.roadLayout.nodes.find((item) => item.id === id)
  if (!node) return
  selectedId.value = id
  draft.value = createRoadNodeDraft(node)
  emit('select', id)
  error.value = ''
  status.value = ''
}
function add(kind: RoadNodeDraft['nodeKind']) {
  if (dirty.value || props.locked || (kind === 'terminal-tee' && hasTee.value)) return
  selectedId.value = null
  emit('select', null)
  draft.value = newRoadNodeDraft(kind)
  markDirty()
}
function discard() {
  if (props.locked) return
  const node = props.scheme.roadLayout.nodes.find((item) => item.id === selectedId.value)
  draft.value = node ? createRoadNodeDraft(node) : null
  dirty.value = false
  error.value = ''
  status.value = ''
}
function apply() {
  if (!draft.value || !dirty.value || props.locked) return
  try {
    const id = draft.value.id ?? props.scheme.roadLayout.nextNodeId
    const result = saveRoadNode(props.scheme, draft.value)
    selectedId.value = id
    emit('select', id)
    dirty.value = false
    error.value = ''
    status.value =
      'Данные примыкания применены. Связанные объекты оставлены на месте; сохраните проект.'
    emit('apply', result)
  } catch (cause) {
    error.value =
      cause instanceof RoadNodeEditError ? cause.message : 'Не удалось изменить примыкание.'
  }
}
function remove() {
  if (selectedId.value === null || dirty.value || props.locked) return
  try {
    const result = removeRoadNode(props.scheme, selectedId.value)
    selectedId.value = null
    draft.value = null
    emit('select', null)
    status.value = 'Примыкание удалено. Действие можно отменить.'
    error.value = ''
    emit('apply', result)
  } catch (cause) {
    error.value =
      cause instanceof RoadNodeEditError ? cause.message : 'Не удалось удалить примыкание.'
  }
}
</script>

<template>
  <section :aria-labelledby="titleId" data-test="road-node-editor">
    <h2 :id="titleId">Примыкания и Т-перекрёсток</h2>
    <p v-if="!scheme.roadLayout.nodes.length" class="hint">
      Здесь можно добавить и изменить данные узла. Рисунок ветвей и автоматика ещё разрабатываются.
      Пока в проекте есть примыкания, перестройка и выпуск недоступны; данные и черновик можно
      сохранить.
    </p>
    <p v-if="legacyGeometry" class="hint">
      Старый исходник сохранён отдельно. Удаление узла из списка не удаляет из него прежнюю
      геометрию; ограничение перестройки и выпуска сохраняется.
    </p>
    <RoadLayoutSummary
      :layout="scheme.roadLayout"
      editable
      :locked="locked || dirty"
      @select="selectNode"
    />
    <div class="actions">
      <button type="button" :disabled="locked || dirty" @click="add('junction')">
        Добавить примыкание
      </button>
      <button type="button" :disabled="locked || dirty || hasTee" @click="add('terminal-tee')">
        Добавить Т-перекрёсток
      </button>
    </div>
    <p v-if="locked" class="hint">Сначала примените или отмените ввод в другой форме.</p>
    <form v-if="draft" @submit.prevent="apply" @input="markDirty" @change="markDirty">
      <fieldset :disabled="locked">
        <legend>
          {{ draft.nodeKind === 'junction' ? 'Параметры примыкания' : 'Параметры Т-перекрёстка' }}
        </legend>
        <div class="fields">
          <label
            >Подход примыкания
            <select v-model="draft.approach">
              <option value="left">Левый — от L0</option>
              <option value="right">Правый — от E</option>
            </select>
          </label>
          <label
            >Расстояние до оси узла, м
            <input v-model="draft.metres" inputmode="decimal" maxlength="5000" />
          </label>
          <label
            >Условный отступ рисунка от L0/E
            <input
              v-model="draft.sheetOffsetXSvg"
              inputmode="decimal"
              maxlength="5000"
              placeholder="Автоматически"
            />
          </label>
          <template v-if="draft.nodeKind === 'junction'">
            <label
              >Сторона примыкания
              <select v-model="draft.side">
                <option value="up">Сверху</option>
                <option value="down">Снизу</option>
              </select>
            </label>
            <label
              >Вид примыкания
              <select v-model="draft.roadKind">
                <option value="road">Дорога</option>
                <option value="yard">Выезд</option>
              </select>
            </label>
            <label class="wide"
              >Название примыкания<input v-model="draft.name" maxlength="5000"
            /></label>
          </template>
          <template v-else>
            <label>Название верхней ветви<input v-model="draft.branchUp" maxlength="5000" /></label>
            <label
              >Название нижней ветви<input v-model="draft.branchDown" maxlength="5000"
            /></label>
          </template>
        </div>
        <label v-if="draft.nodeKind === 'junction'" class="check">
          <input v-model="draft.sideWarningRequested" type="checkbox" /> Сохранить запрос
          предупреждения на примыкающей дороге
        </label>
        <p class="hint">
          Расстояние задаётся от {{ draft.approach === 'left' ? 'L0' : 'E' }} до оси узла. Изменения
          не переставляют стойки и не меняют таблички. Отступ задаётся в условных единицах листа:
          отрицательный — влево, положительный — вправо от L0/E. Пустое поле — автоматическое место
          по расстоянию, без изменения метров. Автоматика знаков пока не подключена.
        </p>
        <p v-if="draft.id !== null && linkCount" class="hint">
          {{ LINKED_ROAD_NODE_DELETE_PROBLEM }}
        </p>
        <p v-if="error" class="error" role="alert">{{ error }}</p>
        <div class="actions">
          <button type="submit" class="primary" :disabled="!dirty">Применить примыкание</button>
          <button type="button" :disabled="!dirty" @click="discard">
            Отменить ввод примыкания
          </button>
          <button
            v-if="draft.id !== null"
            type="button"
            class="danger"
            :disabled="dirty || linkCount > 0"
            @click="remove"
          >
            Удалить примыкание
          </button>
        </div>
      </fieldset>
    </form>
    <p v-if="status" role="status">{{ status }}</p>
  </section>
</template>

<style scoped>
h2 {
  margin: 0 0 0.7rem;
  font-size: 1.4rem;
}
.hint {
  color: #526273;
  line-height: 1.5;
  font-size: 0.9rem;
}
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.6rem;
  margin: 0.8rem 0;
}
fieldset {
  margin: 1rem 0 0;
  border: 1px solid #c8d1df;
  border-radius: 0.5rem;
  padding: 1rem;
}
legend {
  font-weight: 600;
}
.fields {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.8rem;
}
label {
  display: grid;
  gap: 0.4rem;
  font-size: 0.9rem;
}
.wide {
  grid-column: 1 / -1;
}
.check {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
  margin-top: 1rem;
}
.error {
  color: #9b2934;
}
input:not([type='checkbox']),
select {
  display: block;
  width: 100%;
  box-sizing: border-box;
  padding: 0.55rem;
  border: 1px solid #93a5b8;
  border-radius: 0.35rem;
  font: inherit;
}
button {
  padding: 0.55rem 0.7rem;
  border: 1px solid #185ca5;
  border-radius: 0.4rem;
  background: #fff;
  color: #185ca5;
  cursor: pointer;
  font: inherit;
}
button.primary {
  background: #185ca5;
  color: #fff;
}
button.danger {
  border-color: #a22030;
  color: #a22030;
}
button:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}
button:not(:disabled):focus-visible {
  outline: 2px solid #185ca5;
  outline-offset: 2px;
}
@media (max-width: 650px) {
  .fields {
    grid-template-columns: 1fr;
  }
}
</style>
