import { computed, ref } from 'vue'
import { PROTOTYPE_RULES, rulesFrom, type ParameterState } from '../domain/normative-parameters'
import { listParameterStates } from '../services/local-normatives'

/**
 * Общее для приложения состояние нормативных параметров. Загружается из локального API при
 * запуске и после подтверждения параметра или смены документов; без API действуют значения
 * прототипа (ни один параметр не подтверждён).
 */
const states = ref<ParameterState[]>([])
const loading = ref(false)
const error = ref('')
let request: Promise<void> | null = null

async function reload(): Promise<void> {
  if (request) return request
  loading.value = true
  request = (async () => {
    try {
      states.value = await listParameterStates()
      error.value = ''
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : 'Нормативные параметры недоступны.'
    } finally {
      loading.value = false
      request = null
    }
  })()
  return request
}

const rules = computed(() => (states.value.length ? rulesFrom(states.value) : PROTOTYPE_RULES))

export function useNormativeRules() {
  return { states, rules, loading, error, reload }
}
