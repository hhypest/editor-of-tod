<script setup lang="ts">
import { computed } from 'vue'
import type { Scheme } from '../domain/model'
import type { NormativeRules } from '../domain/normative-parameters'
import { decisionEvidenceState } from '../domain/decision-evidence'
import { pddRoads, pddVehicles } from '../domain/pdd-speed'
import { regulationModeLabels } from '../domain/regulation-advice'
const props = defineProps<{ scheme: Scheme; rules: NormativeRules }>()
const entries = computed(() =>
  (['speed', 'regulation'] as const).map((kind) => ({
    kind,
    title: kind === 'speed' ? 'Скорость' : 'Регулирование',
    saved: props.scheme.decisionEvidence[kind],
    state: decisionEvidenceState(props.scheme, kind, props.rules),
  })),
)
function valueText(value: number | Record<string, string> | null) {
  if (value === null) return 'не задано'
  return typeof value === 'number'
    ? String(value)
    : Object.entries(value)
        .map(([key, number]) => `${key}: ${number}`)
        .join('; ')
}
</script>
<template>
  <details class="saved-evidence">
    <summary>Сохранённые основания решений</summary>
    <p>
      Снимок хранит условия и источники на момент записи. Он не удостоверяет безопасность схемы и не
      заменяет ручную сверку.
    </p>
    <section v-for="entry in entries" :key="entry.kind" :data-evidence="entry.kind">
      <h3>
        {{ entry.title }}:
        {{
          entry.state.status === 'missing'
            ? 'основания не записаны'
            : entry.state.status === 'stale'
              ? 'основания устарели'
              : 'основания совпадают с текущими'
        }}
      </h3>
      <p v-for="reason in entry.state.reasons" :key="reason" class="warning">{{ reason }}</p>
      <template v-if="entry.saved">
        <p>Записано: {{ entry.saved.recordedAt }}. {{ entry.saved.note }}</p>
        <p v-if="entry.kind === 'speed' && scheme.decisionEvidence.speed">
          Условия:
          {{
            pddRoads[scheme.decisionEvidence.speed.conditions.road as keyof typeof pddRoads] ??
            'дорога не определена'
          }};
          {{
            pddVehicles[
              scheme.decisionEvidence.speed.conditions.vehicle as keyof typeof pddVehicles
            ] ?? 'состав потока не определён'
          }}. В проекте на момент записи:
          {{ scheme.decisionEvidence.speed.approachSpeedKmh ?? 'не указано' }} км/ч; справочник:
          {{ scheme.decisionEvidence.speed.referenceSpeedKmh ?? 'значения нет' }}.
        </p>
        <template v-if="entry.kind === 'regulation' && scheme.decisionEvidence.regulation">
          <p>
            Выбран режим: {{ regulationModeLabels[scheme.decisionEvidence.regulation.mode] }}.
            Фронт: {{ scheme.decisionEvidence.regulation.input.frontMetres ?? 'не указан' }} м;
            участок: {{ scheme.decisionEvidence.regulation.input.sectionMetres ?? 'не указан' }} м;
            интенсивность:
            {{ scheme.decisionEvidence.regulation.input.hourly || 'не указана' }} авт/ч.
          </p>
          <p v-for="reason in scheme.decisionEvidence.regulation.reasons" :key="reason">
            {{ reason }}
          </p>
          <p
            v-for="warning in scheme.decisionEvidence.regulation.warnings"
            :key="warning"
            class="warning"
          >
            {{ warning }}
          </p>
        </template>
        <ul>
          <li v-for="parameter in entry.saved.parameters" :key="parameter.id">
            <strong>{{ parameter.title }}</strong
            >: {{ valueText(parameter.value) }}. {{ parameter.source }} —
            {{ parameter.confirmed ? 'подтверждено при записи' : 'предварительное значение' }}.
            <span v-if="parameter.document"
              >Источник значения: {{ parameter.document.label }}.</span
            >
            <span v-if="parameter.confirmation"
              >Подтверждение: {{ parameter.confirmation.clause }},
              {{ parameter.confirmation.confirmedAt }}.</span
            >
            <span v-if="parameter.document?.effectiveFrom">
              Дата введения: {{ parameter.document.effectiveFrom }}.</span
            >
            <span
              v-if="
                parameter.currentDocument && parameter.currentDocument.id !== parameter.document?.id
              "
            >
              Действующая редакция при записи: {{ parameter.currentDocument.label }}; подтверждение
              значения относится к прежнему источнику.</span
            >
            <span v-for="amendment in parameter.amendments" :key="amendment.id">
              Изменение: {{ amendment.label
              }}{{ amendment.effectiveFrom ? `, введено ${amendment.effectiveFrom}` : '' }}.</span
            >
          </li>
        </ul>
      </template>
    </section>
  </details>
</template>
<style scoped>
.saved-evidence {
  margin: 1rem 0;
  padding: 0.8rem;
  border: 1px solid #b8c8da;
  border-radius: 0.3rem;
}
summary {
  cursor: pointer;
  font-weight: 600;
}
section + section {
  border-top: 1px solid #b8c8da;
  margin-top: 1rem;
}
li + li {
  margin-top: 0.4rem;
}
.warning {
  color: #854400;
}
</style>
