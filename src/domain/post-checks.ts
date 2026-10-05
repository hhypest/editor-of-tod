import type { Scheme } from './model'
import type { NormativeRules } from './normative-parameters'
import { postMetres, type Approach } from './post-distance'
import { isPlate, postColumns } from './sign-code'

/**
 * Проверки стоек по расстояниям и составу знаков. Это предупреждения для ручной сверки, а не
 * заключение о соответствии: основание и допустимые отступления оценивает составитель.
 */

const SPEED_SIGN = /^3\.24(?:_(\d+))?(?:_ж)?$/

/** Значение знака 3.24, км/ч; код без числа — изображение стандарта со значением 50. */
export function speedSignKmh(code: string): number | null {
  const match = SPEED_SIGN.exec(code)
  return match ? Number(match[1] ?? 50) : null
}

export type SpeedStep = { kmh: number; metres: number; postId: number }
export type StepIntervalProblem = {
  approach: Approach
  from: SpeedStep
  to: SpeedStep
  gapMetres: number
}

/**
 * Ступени ограничения скорости одного подхода: для каждого значения 3.24 — самая дальняя от
 * начала работ стойка, с которой это ограничение начинается. Повтор того же значения ближе к
 * работам ступенью не считается. Стойки без расстояния не участвуют: их место на местности
 * программе неизвестно (ADR-0008).
 */
export function speedSteps(scheme: Scheme, approach: Approach): SpeedStep[] {
  const first = new Map<number, SpeedStep>()
  for (const placement of scheme.placements) {
    if (placement.kind !== 'sign-post' || placement.distance?.approach !== approach) continue
    const metres = postMetres(placement.distance, scheme.parameters.signDistancesMetres)
    if (metres === null) continue
    for (const code of placement.signIds) {
      const kmh = speedSignKmh(code)
      if (kmh === null) continue
      const known = first.get(kmh)
      if (!known || metres > known.metres) first.set(kmh, { kmh, metres, postId: placement.id })
    }
  }
  return [...first.values()].sort((a, b) => b.metres - a.metres || b.kmh - a.kmh)
}

/**
 * Интервалы между последовательными ступенями 3.24 вне диапазона ГОСТ Р 52289, п. 5.4.22
 * (нормативный параметр). Тот же пункт допускает перед местами производства работ ступенчатое
 * ограничение по ГОСТ Р 58350, поэтому результат — повод для сверки, а не запрет.
 */
export function stepIntervalProblems(
  scheme: Scheme,
  rules: NormativeRules,
): { range: readonly [number, number]; problems: StepIntervalProblem[] } | null {
  const { location } = scheme.parameters
  if (location === 'auto') return null
  const range = rules.speedStepInterval[location]
  if (!range) return null
  const problems: StepIntervalProblem[] = []
  for (const approach of ['left', 'right'] as const) {
    const steps = speedSteps(scheme, approach)
    for (let index = 1; index < steps.length; index++) {
      const from = steps[index - 1]!
      const to = steps[index]!
      const gapMetres = Number((from.metres - to.metres).toFixed(3))
      if (gapMetres < range[0] || gapMetres > range[1])
        problems.push({ approach, from, to, gapMetres })
    }
  }
  return problems.length ? { range, problems } : null
}

export type PlateCountProblem = { postId: number; sign: string; plates: number; limit: number }

/**
 * Число табличек под одним знаком больше допустимого (ГОСТ Р 52289, п. 5.9.1, нормативный
 * параметр). Знаки схем Б.33/Б.34 временные, поэтому вне населённого пункта действует предел для
 * временного знака. Табличка относится к знаку по тому же правилу, по которому рисуется на листе.
 * На знак 6.4 предел не распространяется.
 */
export function plateCountProblems(scheme: Scheme, rules: NormativeRules): PlateCountProblem[] {
  const { location } = scheme.parameters
  if (location === 'auto') return []
  const limit = location === 'out' ? rules.plateLimit.temporaryOutside : rules.plateLimit.general
  const problems: PlateCountProblem[] = []
  for (const placement of scheme.placements) {
    if (placement.kind !== 'sign-post') continue
    for (const column of postColumns(placement.signIds)) {
      const sign = placement.signIds[column[0]!]!
      if (isPlate(sign) || /^6\.4(_|$)/.test(sign)) continue
      const plates = column.length - 1
      if (plates > limit) problems.push({ postId: placement.id, sign, plates, limit })
    }
  }
  return problems
}
