<script setup lang="ts">
import type { RoadNode } from '../domain/road-layout'
import type { RoadObjectLinkDraft } from '../domain/road-object-link-draft'
type Draft = NonNullable<RoadObjectLinkDraft['branchPlacement']>
const props = defineProps<{ modelValue: Draft; node?: RoadNode; allowed: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [value: Draft] }>()
function update<K extends keyof Draft>(key: K, value: Draft[K]) {
  emit('update:modelValue', { ...props.modelValue, [key]: value })
}
function enable(event: Event) {
  const enabled = (event.target as HTMLInputElement).checked
  emit('update:modelValue', {
    ...props.modelValue,
    enabled,
    branch: props.node?.kind === 'junction' ? props.node.side : props.modelValue.branch,
  })
}
function value(event: Event) {
  return (event.target as HTMLInputElement).value
}
</script>
<template>
  <div class="branch-fields" data-branch-post-fields>
    <label class="check"
      ><input
        type="checkbox"
        :checked="modelValue.enabled"
        :disabled="!allowed && !modelValue.enabled"
        @change="enable"
      />
      Разместить стойку на ветви</label
    >
    <template v-if="modelValue.enabled">
      <label
        >Ветвь стойки
        <select
          :value="modelValue.branch"
          :disabled="node?.kind === 'junction'"
          @change="update('branch', value($event) as Draft['branch'])"
        >
          <option value="">Выберите ветвь</option>
          <option v-if="node?.kind !== 'junction' || node.side === 'up'" value="up">
            Верхняя ветвь
          </option>
          <option v-if="node?.kind !== 'junction' || node.side === 'down'" value="down">
            Нижняя ветвь
          </option>
        </select>
      </label>
      <label
        >Отступ вдоль ветви, усл. ед.<input
          :value="modelValue.alongSvg"
          inputmode="decimal"
          maxlength="5000"
          @input="update('alongSvg', value($event))"
      /></label>
      <label
        >Сдвиг поперёк ветви, усл. ед.<input
          :value="modelValue.acrossSvg"
          inputmode="decimal"
          maxlength="5000"
          @input="update('acrossSvg', value($event))"
      /></label>
      <label
        >Поворот стойки на листе
        <select
          :value="modelValue.rotation"
          @change="update('rotation', value($event) as Draft['rotation'])"
        >
          <option value="0">0° — без поворота</option>
          <option value="90">90° — по часовой стрелке</option>
          <option value="180">180°</option>
          <option value="270">270° — по часовой стрелке</option>
        </select>
      </label>
      <p>
        Отступ вдоль задаётся от оси узла наружу по выбранной ветви. Поперечный сдвиг: минус —
        влево, плюс — вправо. Это условные единицы листа, отдельно от замера в метрах. Сторона и
        опора задаются до поворота. Прежнее положение на основной дороге сохранено и вернётся после
        снятия размещения на ветви.
      </p>
    </template>
    <p v-else>
      Размещение на ветви доступно для предупреждения на примыкающей дороге и объекта Т-перекрёстка.
    </p>
  </div>
</template>
<style scoped>
.branch-fields {
  margin-top: 1rem;
  border-top: 1px solid #c8d1df;
  padding-top: 0.5rem;
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
  padding: 0.5rem;
  margin-top: 0.3rem;
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
p {
  font-size: 0.9rem;
  color: #526273;
  line-height: 1.5;
}
:focus-visible {
  outline: 3px solid #185ca5;
  outline-offset: 2px;
}
</style>
