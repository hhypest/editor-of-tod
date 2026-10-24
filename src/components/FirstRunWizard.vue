<script setup lang="ts">
import { computed } from 'vue'
import { ready, type FirstRunStatus } from '../presentation/first-run'
const props = defineProps<{ status: FirstRunStatus; locked?: boolean }>()
const emit = defineEmits<{ open: [] }>()
const complete = computed(
  () =>
    props.status.signs > 0 &&
    props.status.cards > 0 &&
    !props.status.parametersError &&
    ready(props.status.parameters) &&
    ready(props.status.pdd),
)
</script>
<template>
  <section
    class="setup-guide module setup-complete"
    aria-labelledby="setup-heading"
    data-testid="first-run-wizard"
  >
    <div class="setup-summary">
      <div>
        <strong id="setup-heading">{{
          complete ? 'Настройка завершена' : 'Настройка не завершена'
        }}</strong>
        <p>
          Знаков: {{ status.signs }} · карточек ПУ-66: {{ status.cards }} · параметров:
          {{ status.parameters.confirmed }} из {{ status.parameters.total }}.
        </p>
      </div>
      <button type="button" :disabled="locked" @click="emit('open')">
        {{ complete ? 'Проверить настройку' : 'Продолжить настройку' }}
      </button>
    </div>
  </section>
</template>
<style scoped src="../styles/editor-common.css" />
<style scoped src="../styles/FirstRunWizard.css" />
