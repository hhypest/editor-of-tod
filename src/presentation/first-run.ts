export interface SetupReadiness {
  confirmed: number
  total: number
}

export interface FirstRunStatus {
  cards: number
  signs: number
  parameters: SetupReadiness
  pdd: SetupReadiness
}

export function ready(readiness: SetupReadiness): boolean {
  return readiness.total > 0 && readiness.confirmed === readiness.total
}
