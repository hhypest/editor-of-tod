<script setup lang="ts">
import { anchorLabels, placementTitle } from '../domain/placement-labels'
import { templateLabel } from '../domain/registry'
import type { Scheme } from '../domain/model'

defineProps<{ scheme: Scheme }>()
const zoneCodes = ['b33', 'b34'] as const

function metres(value: number | null): string {
  return value === null ? 'не указано' : `${value} м`
}
</script>

<template>
  <details class="inspector">
    <summary>Технические данные открытого проекта</summary>
    <p>
      Значения показаны без нормативной проверки. Координаты объектов заданы в условных единицах,
      расстояния — в метрах.
    </p>
    <dl>
      <div>
        <dt>Участок</dt>
        <dd>{{ scheme.parameters.locationText || 'не указано' }}</dd>
      </div>
      <div>
        <dt>Направления</dt>
        <dd>{{ scheme.parameters.directions.left }} / {{ scheme.parameters.directions.right }}</dd>
      </div>
      <div>
        <dt>Расстояния d300 / d250 / d150 / d50</dt>
        <dd>
          {{ metres(scheme.parameters.signDistancesMetres.d300) }} /
          {{ metres(scheme.parameters.signDistancesMetres.d250) }} /
          {{ metres(scheme.parameters.signDistancesMetres.d150) }} /
          {{ metres(scheme.parameters.signDistancesMetres.d50) }}
        </dd>
      </div>
      <div>
        <dt>Ступени скорости</dt>
        <dd>{{ scheme.parameters.speedStagesKmh.join(' / ') }} км/ч</dd>
      </div>
      <div>
        <dt>Жёлтый фон временных знаков</dt>
        <dd>{{ scheme.parameters.yellowTemporarySigns ? 'да' : 'нет' }}</dd>
      </div>
      <div v-for="code in zoneCodes" :key="code">
        <dt>{{ templateLabel(code) }}: отвод / буфер / фронт</dt>
        <dd v-if="scheme.parameters.workZones[code]">
          {{ scheme.parameters.workZones[code]!.taperMetres }} /
          {{ scheme.parameters.workZones[code]!.bufferMetres }} /
          {{ scheme.parameters.workZones[code]!.workMetres }} м
        </dd>
        <dd v-else>не заполнено</dd>
      </div>
    </dl>
    <div class="table-scroll">
      <table>
        <caption>
          Объекты и условные координаты
        </caption>
        <thead>
          <tr>
            <th scope="col">ID</th>
            <th scope="col">Содержимое</th>
            <th scope="col">Координаты</th>
            <th scope="col">Происхождение</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="placement in scheme.placements" :key="placement.id">
            <td>{{ placement.id }}</td>
            <td>
              {{ placementTitle(placement) }}
            </td>
            <td>
              {{ anchorLabels[placement.position.anchor] }}; x={{ placement.position.offsetXSvg }};
              y={{
                placement.kind === 'sign-post'
                  ? placement.position.offsetYSvg
                  : placement.position.ySvg
              }}
            </td>
            <td>{{ placement.generatedByTemplate ? 'автоматически' : 'вручную' }}</td>
          </tr>
          <tr v-if="!scheme.placements.length">
            <td colspan="4">Объектов пока нет.</td>
          </tr>
        </tbody>
      </table>
    </div>
  </details>
</template>

<style scoped>
.inspector {
  padding: 1rem;
  border: 1px solid #d8e1df;
  border-radius: 0.7rem;
  background: white;
}
summary {
  color: #215d50;
  cursor: pointer;
  font-weight: 700;
}
p,
dt,
caption {
  color: #526273;
}
dl {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(13rem, 1fr));
  gap: 1rem;
}
dd {
  margin: 0.25rem 0 0;
  overflow-wrap: anywhere;
}
.table-scroll {
  overflow-x: auto;
}
table {
  width: 100%;
  border-collapse: collapse;
  text-align: left;
}
caption {
  padding: 1rem 0 0.3rem;
  text-align: left;
}
th,
td {
  padding: 0.65rem;
  border-bottom: 1px solid #d8e1df;
  vertical-align: top;
}
</style>
