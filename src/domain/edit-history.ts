export type EditHistory<T> = {
  past: T[]
  present: T
  future: T[]
}

const MAX_UNDO_STEPS = 30

export function startHistory<T>(present: T): EditHistory<T> {
  return { past: [], present, future: [] }
}

export function recordEdit<T>(history: EditHistory<T>, next: T): EditHistory<T> {
  if (history.present === next) return history
  return {
    past: [...history.past, history.present].slice(-MAX_UNDO_STEPS),
    present: next,
    future: [],
  }
}

export function undoEdit<T>(history: EditHistory<T>): EditHistory<T> {
  const previous = history.past.at(-1)
  if (previous === undefined) return history
  return {
    past: history.past.slice(0, -1),
    present: previous,
    future: [history.present, ...history.future],
  }
}

export function redoEdit<T>(history: EditHistory<T>): EditHistory<T> {
  const next = history.future[0]
  if (next === undefined) return history
  return {
    past: [...history.past, history.present],
    present: next,
    future: history.future.slice(1),
  }
}
