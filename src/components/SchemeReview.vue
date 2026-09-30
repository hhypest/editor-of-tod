<script setup lang="ts">
import { computed } from 'vue'
import type { Scheme } from '../domain/model'
import { reviewScheme, type ReviewFinding } from '../domain/review-scheme'
import { useNormativeRules } from '../composables/useNormativeRules'
import { markState, setMark } from '../domain/review-marks'

const props = defineProps<{ scheme: Scheme; hasPendingInput: boolean; locked?: boolean }>()
const emit = defineEmits<{ navigate: [finding: ReviewFinding]; apply: [scheme: Scheme] }>()
const { rules } = useNormativeRules()
const findings = computed(() => reviewScheme(props.scheme, rules.value))
const toFill = computed(() => findings.value.filter((finding) => finding.kind === 'fill'))
const toVerify = computed(() =>
  findings.value
    .filter((finding) => finding.kind === 'verify')
    .map((finding) => ({ finding, state: markState(props.scheme, finding) })),
)
const markedCount = computed(
  () => toVerify.value.filter(({ state }) => state.status === 'marked').length,
)

function toggle(finding: ReviewFinding, event: Event): void {
  if (props.locked || props.hasPendingInput) return
  const checked = (event.target as HTMLInputElement).checked
  emit('apply', setMark(props.scheme, findings.value, finding.id, checked))
}

function when(iso: string): string {
  return new Date(iso).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' })
}
</script>

<template>
  <section aria-labelledby="review-title">
    <h2 id="review-title">Проверка заполнения черновика</h2>
    <p class="hint">
      Список пересчитывается после применения правок. Пустое поле не всегда обязательно для
      конкретного листа. Это напоминания составителю, а не проверка соответствия нормам или
      подтверждение согласования.
    </p>
    <p v-if="hasPendingInput" class="pending" role="status">
      В форме есть неприменённые изменения. Список пока относится к последней применённой версии.
    </p>

    <h3 aria-live="polite">Нужно заполнить или уточнить ({{ toFill.length }})</h3>
    <p v-if="!toFill.length">Пустых полей из этого списка нет.</p>
    <ul v-else>
      <li v-for="finding in toFill" :key="finding.id">
        <strong>{{ finding.title }}</strong> — {{ finding.detail }}
        <a :href="finding.target" @click.prevent="emit('navigate', finding)">Перейти</a>
      </li>
    </ul>

    <h3 aria-live="polite">
      Проверить вручную ({{ toVerify.length }}) · отмечено {{ markedCount }} из
      {{ toVerify.length }}
    </h3>
    <p class="hint">
      Проверив пункт, поставьте отметку «Проверено». Она сохраняется в проекте и снимается, если
      пункт или проверяемые данные изменились. Выпускной лист доступен, когда отмечены все пункты.
    </p>
    <ul class="checks">
      <li
        v-for="{ finding, state } in toVerify"
        :key="finding.id"
        :class="state.status"
        :data-check="finding.id"
      >
        <label class="mark">
          <input
            type="checkbox"
            :checked="state.status === 'marked'"
            :disabled="locked || hasPendingInput || state.status === 'blocked'"
            @change="toggle(finding, $event)"
          />
          Проверено
        </label>
        <div>
          <strong>{{ finding.title }}</strong> — {{ finding.detail }}
          <a :href="finding.target" @click.prevent="emit('navigate', finding)">Перейти</a>
          <small v-if="state.status === 'marked'" class="mark-note">
            Отмечено {{ when(state.markedAt) }}.
          </small>
          <small v-else-if="state.status === 'blocked'" class="mark-note stale">
            {{ state.reason }}
          </small>
          <small v-else-if="state.status === 'stale'" class="mark-note stale">
            Отмечено {{ when(state.markedAt) }}, но после этого пункт изменился — проверьте снова.
          </small>
        </div>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.hint {
  color: #526273;
  line-height: 1.5;
}
.pending {
  padding: 0.7rem;
  border-left: 3px solid #a46b10;
  background: #fff7e9;
}
li {
  margin: 0.5rem 0;
  line-height: 1.5;
}
a {
  white-space: nowrap;
  color: #175c9e;
}
.checks {
  padding: 0;
  list-style: none;
}
.checks li {
  display: grid;
  grid-template-columns: 8.5rem minmax(0, 1fr);
  gap: 0.8rem;
  padding: 0.6rem 0.7rem;
  border: 1px solid #d8e1eb;
  border-radius: 0.4rem;
}
.checks li.marked {
  border-color: #9cc7ae;
  background: #f1f8f3;
}
.checks li.stale {
  border-color: #e0b35c;
  background: #fff8e8;
}
.mark {
  display: flex;
  align-items: flex-start;
  gap: 0.4rem;
  font-weight: 600;
}
.mark input {
  margin-top: 0.25rem;
}
.mark-note {
  display: block;
  margin-top: 0.3rem;
  color: #2f6b47;
}
.mark-note.stale {
  color: #8a5a00;
}
@media (max-width: 640px) {
  .checks li {
    grid-template-columns: 1fr;
  }
}
</style>
