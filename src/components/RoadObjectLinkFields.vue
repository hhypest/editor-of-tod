<script setup lang="ts">
import { computed } from 'vue'
import type { RoadLayout } from '../domain/road-layout'
import type { RoadObjectLinkDraft } from '../domain/road-object-link-draft'

const props = defineProps<{ modelValue: RoadObjectLinkDraft; layout: RoadLayout }>()
const emit = defineEmits<{ 'update:modelValue': [value: RoadObjectLinkDraft] }>()
const selected = computed(() =>
  props.layout.nodes.find((node) => String(node.id) === props.modelValue.nodeId),
)
function update<K extends keyof RoadObjectLinkDraft>(key: K, value: RoadObjectLinkDraft[K]) {
  emit('update:modelValue', { ...props.modelValue, [key]: value })
}
function target(event: Event): string {
  return (event.target as HTMLInputElement).value
}
function chooseNode(event: Event) {
  const nodeId = target(event),
    node = props.layout.nodes.find((node) => String(node.id) === nodeId)
  emit('update:modelValue', {
    ...props.modelValue,
    nodeId,
    role:
      node?.kind === 'terminal-tee'
        ? 'tee-branch'
        : props.modelValue.role === 'tee-branch'
          ? 'main-repeat'
          : props.modelValue.role,
    installationKnown: false,
    installationMetres: '',
  })
}
</script>

<template>
  <fieldset class="road-link" data-road-object-link>
    <legend>Связь стойки с примыканием</legend>
    <label
      >Узел для стойки
      <select :value="modelValue.nodeId" @change="chooseNode">
        <option value="">Без связи с примыканием</option>
        <option v-for="node in layout.nodes" :key="node.id" :value="String(node.id)">
          № {{ node.id }} —
          {{
            node.kind === 'junction'
              ? node.name || (node.roadKind === 'yard' ? 'выезд' : 'дорога')
              : 'Т-перекрёсток'
          }}
          ({{ node.position.from }})
        </option>
      </select>
    </label>
    <template v-if="modelValue.nodeId">
      <p v-if="!selected" class="error">
        Узел из восстановленного ввода не найден. Выберите его заново.
      </p>
      <label
        >Назначение стойки у узла
        <select
          :value="modelValue.role"
          @change="update('role', target($event) as RoadObjectLinkDraft['role'])"
        >
          <option v-if="selected?.kind === 'terminal-tee'" value="tee-branch">
            Объект Т-перекрёстка
          </option>
          <template v-else>
            <option value="main-repeat">Повтор на основной дороге</option>
            <option value="side-warning">Предупреждение на примыкающей дороге</option>
          </template>
        </select>
      </label>
      <label class="check"
        ><input
          type="checkbox"
          :checked="modelValue.installationKnown"
          @change="update('installationKnown', ($event.target as HTMLInputElement).checked)"
        />
        Замер установки стойки заполнен</label
      >
      <div v-if="modelValue.installationKnown" class="fields">
        <label
          >Точка отсчёта установки
          <select
            :value="modelValue.installationFrom"
            @change="
              update('installationFrom', target($event) as RoadObjectLinkDraft['installationFrom'])
            "
          >
            <option value="node-axis">Ось выбранного узла</option>
            <option value="L0">L0</option>
            <option value="E">E</option>
          </select>
        </label>
        <label
          >Расстояние установки стойки, м<input
            :value="modelValue.installationMetres"
            inputmode="decimal"
            maxlength="5000"
            @input="update('installationMetres', target($event))"
        /></label>
      </div>
      <p class="hint">
        Замер установки независим от расстояния до примыкания и числа на табличке. При выборе
        другого узла замер нужно заполнить заново. Эти поля сохраняют связь и замер; положение и
        ориентация стойки на рисунке сохраняются.
      </p>
    </template>
    <p v-else class="hint">
      Без связи стойка остаётся самостоятельным ручным объектом. Снятие связи сохраняет стойку,
      знаки и положение.
    </p>
  </fieldset>
</template>

<style scoped>
.road-link {
  margin: 1rem 0;
  padding: 1rem;
  border: 1px solid #b5c6d6;
  border-radius: 0.4rem;
}
legend {
  font-weight: 600;
}
label {
  display: block;
  margin: 0.6rem 0;
  font-size: 0.9rem;
}
input:not([type='checkbox']),
select {
  display: block;
  box-sizing: border-box;
  width: 100%;
  margin-top: 0.3rem;
  padding: 0.5rem;
  border: 1px solid #93a5b8;
  border-radius: 0.35rem;
  font: inherit;
  background: #fff;
}
.check {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
.fields {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(13rem, 1fr));
  gap: 1rem;
}
.hint {
  color: #526273;
  font-size: 0.9rem;
  line-height: 1.5;
}
.error {
  color: #a22030;
}
:focus-visible {
  outline: 3px solid #185ca5;
  outline-offset: 2px;
}
</style>
