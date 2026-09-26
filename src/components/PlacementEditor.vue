<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import {
  createPlacementDraft,
  newSignDraft,
  newTextDraft,
  PlacementEditError,
  removePlacement,
  savePlacement,
  type PlacementDraft,
} from '../domain/edit-placements'
import type { Scheme } from '../domain/model'

type SignMeta = { code: string; width: number; height: number }
const props = defineProps<{ scheme: Scheme; locked?: boolean }>()
const emit = defineEmits<{ apply: [scheme: Scheme]; dirty: [value: boolean] }>()
const selectedId = ref<number | null>(props.scheme.placements[0]?.id ?? null)
const draft = ref<PlacementDraft | null>(
  props.scheme.placements[0] ? createPlacementDraft(props.scheme.placements[0]) : null,
)
const dirty = ref(false)
const error = ref('')
const status = ref('')
const catalogError = ref('')
const catalog = ref<SignMeta[]>([])
const query = ref('')
const knownCodes = computed(() => new Set(catalog.value.map((sign) => sign.code)))
const matches = computed(() =>
  catalog.value
    .filter((sign) => sign.code.toLowerCase().includes(query.value.trim().toLowerCase()))
    .slice(0, 12),
)
const currentCodes = computed(() =>
  draft.value?.kind === 'sign-post'
    ? draft.value.signCodes
        .split(/[,;\n]/)
        .map((code) => code.trim())
        .filter(Boolean)
    : [],
)

onMounted(async () => {
  try {
    const response = await fetch('/api/signs')
    if (!response.ok) throw new Error('Каталог знаков недоступен.')
    catalog.value = (await response.json()) as SignMeta[]
  } catch {
    catalogError.value = 'Не удалось открыть локальный каталог PNG; коды можно ввести вручную.'
  }
})

watch(
  () => props.scheme,
  (scheme) => {
    const selected =
      scheme.placements.find((placement) => placement.id === selectedId.value) ??
      scheme.placements[0]
    selectedId.value = selected?.id ?? null
    draft.value = selected ? createPlacementDraft(selected) : null
    dirty.value = false
    emit('dirty', false)
  },
)

function markDirty(): void {
  if (props.locked) return
  error.value = ''
  status.value = ''
  if (!dirty.value) {
    dirty.value = true
    emit('dirty', true)
  }
}

function selectPlacement(id: number): void {
  if (dirty.value || props.locked) return
  const selected = props.scheme.placements.find((placement) => placement.id === id)
  if (!selected) return
  selectedId.value = id
  draft.value = createPlacementDraft(selected)
  error.value = ''
  status.value = ''
}

function createNew(kind: 'sign-post' | 'text'): void {
  if (dirty.value || props.locked) return
  selectedId.value = null
  draft.value = kind === 'sign-post' ? newSignDraft() : newTextDraft()
  markDirty()
}

function discard(): void {
  const selected = props.scheme.placements.find((placement) => placement.id === selectedId.value)
  draft.value = selected ? createPlacementDraft(selected) : null
  dirty.value = false
  error.value = ''
  status.value = ''
  emit('dirty', false)
}

function appendCode(code: string): void {
  if (draft.value?.kind !== 'sign-post' || props.locked) return
  draft.value.signCodes = draft.value.signCodes.trim()
    ? `${draft.value.signCodes.trim()}, ${code}`
    : code
  markDirty()
}

function applyDraft(): void {
  if (!draft.value || props.locked) return
  try {
    const id = draft.value.id ?? props.scheme.nextPlacementId
    const updated = savePlacement(props.scheme, draft.value)
    selectedId.value = id
    dirty.value = false
    error.value = ''
    status.value = `Объект ${id} применён к проекту. Скачайте копию v2 для сохранения.`
    emit('apply', updated)
    emit('dirty', false)
  } catch (cause) {
    error.value =
      cause instanceof PlacementEditError ? cause.message : 'Не удалось изменить объект.'
  }
}

function removeSelected(): void {
  if (selectedId.value === null || dirty.value || props.locked) return
  try {
    const id = selectedId.value
    const updated = removePlacement(props.scheme, id)
    selectedId.value = null
    draft.value = null
    status.value = `Объект ${id} удалён из проекта. Действие можно отменить.`
    error.value = ''
    emit('apply', updated)
  } catch (cause) {
    error.value = cause instanceof PlacementEditError ? cause.message : 'Не удалось удалить объект.'
  }
}
</script>

<template>
  <section aria-labelledby="placements-title">
    <h2 id="placements-title">Объекты проекта</h2>
    <p class="hint">
      Выберите объект для изменения свойств или добавьте ручную стойку/надпись. Координаты сохранены
      в условной системе старого листа, не в метрах. После ручной правки автоматический объект
      становится ручным. Расстановка по ОДМ здесь не выполняется.
    </p>
    <p v-if="locked" class="hint" role="status">
      Сначала примените или отмените изменения параметров выше.
    </p>
    <div class="actions">
      <button type="button" :disabled="dirty || locked" @click="createNew('sign-post')">
        Добавить стойку
      </button>
      <button type="button" :disabled="dirty || locked" @click="createNew('text')">
        Добавить надпись
      </button>
    </div>

    <div class="workspace">
      <nav aria-label="Объекты открытого проекта" class="object-list">
        <p v-if="!scheme.placements.length" class="hint">Объектов пока нет.</p>
        <button
          v-for="item in scheme.placements"
          :key="item.id"
          type="button"
          :aria-pressed="selectedId === item.id"
          :disabled="dirty || locked"
          @click="selectPlacement(item.id)"
        >
          № {{ item.id }} ·
          {{
            item.kind === 'sign-post'
              ? `Стойка ${item.signIds.join(', ')}`
              : item.elementKind === 'text'
                ? `Надпись ${item.text ?? ''}`
                : `Элемент ${item.elementKind}`
          }}
        </button>
      </nav>

      <form
        v-if="draft"
        class="properties"
        :inert="locked"
        @submit.prevent="applyDraft"
        @input="markDirty"
        @change="markDirty"
      >
        <h3>{{ draft.id === null ? 'Новый объект' : `Свойства объекта № ${draft.id}` }}</h3>
        <p v-if="draft.id !== null" class="hint">
          {{
            scheme.placements.find((item) => item.id === draft?.id)?.generatedByTemplate
              ? 'Создан шаблоном: после изменения будет ручным.'
              : 'Ручной объект.'
          }}
        </p>
        <div class="fields">
          <label
            >Привязка
            <select v-model="draft.anchor">
              <option
                v-for="anchor in ['abs', 'L0', 'L1', 'Z0', 'Z1', 'E', 'AX']"
                :key="anchor"
                :value="anchor"
              >
                {{ anchor }}
              </option>
            </select>
          </label>
          <label>X <input v-model="draft.x" type="text" inputmode="decimal" /></label>
          <label>Y <input v-model="draft.y" type="text" inputmode="decimal" /></label>
        </div>

        <template v-if="draft.kind === 'sign-post'">
          <div class="fields">
            <label
              >Сторона
              <select v-model="draft.side">
                <option value="up">up</option>
                <option value="down">down</option>
              </select>
            </label>
            <label
              >Опора
              <select v-model="draft.stand">
                <option value="left">left</option>
                <option value="right">right</option>
              </select>
            </label>
            <label>Подпись расстояния <input v-model="draft.distanceLabel" type="text" /></label>
          </div>
          <label
            >Коды знаков через запятую
            <textarea v-model="draft.signCodes" rows="2" placeholder="Например, 1.25, 3.24_40_ж" />
          </label>
          <div v-if="currentCodes.length" class="previews">
            <figure v-for="(code, index) in currentCodes" :key="`${index}-${code}`">
              <img
                v-if="knownCodes.has(code)"
                :src="`/api/signs/${encodeURIComponent(code)}/image`"
                :alt="`Знак ${code}`"
                loading="lazy"
              />
              <div v-else class="missing">Нет PNG в локальном каталоге</div>
              <figcaption>{{ code }}</figcaption>
            </figure>
          </div>
          <div class="palette">
            <h4>Добавить из локального каталога</h4>
            <p v-if="catalogError" class="hint" role="status">{{ catalogError }}</p>
            <label
              >Поиск по коду
              <input
                v-model="query"
                type="search"
                placeholder="Номер знака"
                @input.stop
                @change.stop
            /></label>
            <div class="palette-results">
              <button
                v-for="sign in matches"
                :key="sign.code"
                type="button"
                @click="appendCode(sign.code)"
              >
                <img
                  :src="`/api/signs/${encodeURIComponent(sign.code)}/image`"
                  :alt="`Знак ${sign.code}`"
                  loading="lazy"
                />
                {{ sign.code }}
              </button>
            </div>
            <p v-if="!catalogError && !catalog.length" class="hint">
              В локальной базе пока нет знаков.
            </p>
          </div>
        </template>
        <template v-else>
          <p>Тип: {{ draft.elementKind }}</p>
          <div v-if="draft.elementKind !== 'text'" class="fields">
            <label>Ширина <input v-model="draft.width" type="text" inputmode="decimal" /></label>
            <label>Высота <input v-model="draft.height" type="text" inputmode="decimal" /></label>
          </div>
          <label v-if="draft.elementKind === 'text'"
            >Текст надписи <textarea v-model="draft.text" rows="3" />
          </label>
          <div v-if="draft.elementKind === 'text'" class="fields">
            <label
              >Размер шрифта <input v-model="draft.fontSize" type="text" inputmode="decimal"
            /></label>
            <label class="checkbox"
              ><input v-model="draft.bold" type="checkbox" /> Полужирный</label
            >
          </div>
        </template>

        <p v-if="error" class="error" role="alert">{{ error }}</p>
        <p v-if="status" class="hint" role="status">{{ status }}</p>
        <div class="actions">
          <button type="submit" class="primary" :disabled="locked || !dirty">
            Применить объект
          </button>
          <button type="button" :disabled="locked || !dirty" @click="discard">Отменить ввод</button>
          <button
            v-if="draft.id !== null"
            type="button"
            class="danger"
            :disabled="locked || dirty"
            @click="removeSelected"
          >
            Удалить объект
          </button>
        </div>
      </form>
      <p v-else class="hint">Выберите объект или добавьте новый.</p>
    </div>
    <p v-if="!draft && status" class="hint" role="status">{{ status }}</p>
  </section>
</template>

<style scoped>
h2 {
  margin: 0 0 1rem;
  font-size: 1.4rem;
}
h3 {
  margin: 0 0 0.6rem;
  font-size: 1.05rem;
}
h4 {
  margin: 0 0 0.5rem;
}
.hint {
  color: #526273;
  font-size: 0.9rem;
  line-height: 1.5;
}
.error {
  color: #a22030;
  font-weight: 600;
}
.actions {
  display: flex;
  gap: 0.7rem;
  flex-wrap: wrap;
  margin: 1rem 0;
}
.workspace {
  display: grid;
  grid-template-columns: minmax(12rem, 15rem) minmax(0, 1fr);
  gap: 1rem;
  margin-top: 1rem;
}
.object-list {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  max-height: 35rem;
  overflow: auto;
}
.object-list button {
  text-align: left;
  overflow-wrap: anywhere;
}
.object-list button[aria-pressed='true'] {
  background: #e9f2fd;
  border-color: #185ca5;
}
.properties {
  min-width: 0;
  padding: 1rem;
  border: 1px solid #d8e1eb;
  border-radius: 0.45rem;
}
.fields {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr));
  gap: 0.7rem;
  margin: 0.8rem 0;
}
label {
  display: block;
  margin: 0.7rem 0;
  font-size: 0.9rem;
  font-weight: 600;
}
input[type='text'],
input[type='search'],
select,
textarea {
  display: block;
  width: 100%;
  box-sizing: border-box;
  margin-top: 0.3rem;
  padding: 0.55rem;
  border: 1px solid #93a5b8;
  border-radius: 0.35rem;
  font: inherit;
}
.checkbox {
  align-self: end;
}
.checkbox input {
  width: auto;
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
.previews,
.palette-results {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
  max-height: 15rem;
  overflow: auto;
}
figure {
  width: 5rem;
  margin: 0;
  padding: 0.4rem;
  border: 1px solid #d8e1eb;
  border-radius: 0.35rem;
  text-align: center;
}
figure img {
  width: 100%;
  height: 3.5rem;
  object-fit: contain;
}
figcaption {
  overflow-wrap: anywhere;
  font-size: 0.8rem;
}
.missing {
  min-height: 3.5rem;
  color: #a22030;
  font-size: 0.75rem;
}
.palette {
  margin: 1rem 0;
  padding: 0.8rem;
  background: #f3f6fa;
  border-radius: 0.4rem;
}
.palette-results button {
  display: flex;
  flex-direction: column;
  align-items: center;
  width: 5.5rem;
  overflow-wrap: anywhere;
  font-size: 0.8rem;
}
.palette-results img {
  width: 4rem;
  height: 3.5rem;
  object-fit: contain;
}
@media (max-width: 42rem) {
  .workspace {
    grid-template-columns: 1fr;
  }
  .object-list {
    max-height: 12rem;
  }
}
</style>
