import { shallowRef } from 'vue'
import type { Scheme } from '../domain/model'
import {
  recordEdit,
  redoEdit,
  startHistory,
  undoEdit,
  type EditHistory,
} from '../domain/edit-history'

/** One history for the one open document; storage and recovery do not belong here. */
export function useProjectHistory() {
  const history = shallowRef<EditHistory<Scheme> | null>(null)

  function start(scheme: Scheme): void {
    history.value = startHistory(scheme)
  }
  function reset(): void {
    history.value = null
  }
  function record(current: Scheme, next: Scheme): void {
    history.value = recordEdit(history.value ?? startHistory(current), next)
  }
  function step(direction: 'back' | 'forward'): Scheme | null {
    if (
      !history.value ||
      !(direction === 'back' ? history.value.past : history.value.future).length
    )
      return null
    history.value = direction === 'back' ? undoEdit(history.value) : redoEdit(history.value)
    return history.value.present
  }
  return { history, start, reset, record, step }
}

export type ProjectHistory = ReturnType<typeof useProjectHistory>
