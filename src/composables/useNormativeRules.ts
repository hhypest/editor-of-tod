import { storeToRefs } from 'pinia'
import { useNormativeRulesStore } from '../stores/normative-rules'

/** Compatible ref-based facade; the app's store owns the state and request. */
export function useNormativeRules() {
  const store = useNormativeRulesStore()
  return { ...storeToRefs(store), reload: store.reload }
}
