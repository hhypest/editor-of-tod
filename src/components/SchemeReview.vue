<script setup lang="ts">
import { computed } from 'vue'
import type { Scheme } from '../domain/model'
import { reviewScheme, type ReviewFinding } from '../domain/review-scheme'
import { useNormativeRules } from '../composables/useNormativeRules'

const props = defineProps<{ scheme: Scheme; hasPendingInput: boolean }>()
const emit = defineEmits<{ navigate: [finding: ReviewFinding] }>()
const { rules } = useNormativeRules()
const findings = computed(() => reviewScheme(props.scheme, rules.value))
const toFill = computed(() => findings.value.filter((finding) => finding.kind === 'fill'))
const toVerify = computed(() => findings.value.filter((finding) => finding.kind === 'verify'))
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

    <h3 aria-live="polite">Проверить вручную ({{ toVerify.length }})</h3>
    <ul>
      <li v-for="finding in toVerify" :key="finding.id">
        <strong>{{ finding.title }}</strong> — {{ finding.detail }}
        <a :href="finding.target" @click.prevent="emit('navigate', finding)">Перейти</a>
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
</style>
