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
 * Ступени ограничения скорости одного подхода в порядке движения к месту работ. Знаки 3.24
 * упорядочены по расстоянию; подряд идущие знаки с одним значением — одна ступень, она
 * начинается с самого дальнего из них (повтор действующего ограничения ступенью не считается).
 * То же значение после другого — новая ступень: 70 → 50 → 70 → 40 даёт четыре ступени.
 * Стойки без расстояния не участвуют: их место на местности программе неизвестно (ADR-0008).
 */
export function speedSteps(scheme: Scheme, approach: Approach): SpeedStep[] {
  const signs: SpeedStep[] = []
  for (const placement of scheme.placements) {
    if (placement.kind !== 'sign-post' || placement.distance?.approach !== approach) continue
    const metres = postMetres(placement.distance, scheme.parameters.signDistancesMetres)
    if (metres === null) continue
    for (const code of placement.signIds) {
      const kmh = speedSignKmh(code)
      if (kmh !== null) signs.push({ kmh, metres, postId: placement.id })
    }
  }
  signs.sort((a, b) => b.metres - a.metres || b.kmh - a.kmh || a.postId - b.postId)
  return signs.filter((sign, index) => sign.kmh !== signs[index - 1]?.kmh)
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

export type SingleWarningProblem = {
  approach: Approach
  postId: number
  metres: number
  hasDistancePlate: boolean
}

/**
 * Особый случай п. 5.2.27: при краткосрочных работах и скорости не более 40 км/ч допускается
 * один знак 1.25 без таблички 8.1.1 на переносной опоре в 10–15 м от места работ. Проверяются
 * только подходы, где на схеме действительно оставлен один знак 1.25; обычный повторный знак у
 * начала работ и дальнее предупреждение не перестраиваются и не признаются ошибкой автоматически.
 */
export function singleWarningProblems(
  scheme: Scheme,
  rules: NormativeRules,
): {
  range: readonly [number, number]
  maxSpeedKmh: number
  problems: SingleWarningProblem[]
} | null {
  if (
    scheme.parameters.workConditions.kind !== 'short' ||
    scheme.parameters.speedStagesKmh[2] > rules.singleWarningMaxSpeedKmh ||
    !rules.singleWarningDistance
  )
    return null
  const range = rules.singleWarningDistance
  // Без подхода хотя бы одного знака нельзя утверждать, что на другом подходе знак одиночный.
  // Стойки без расстояния по-прежнему перечисляются отдельным пунктом ручной сверки.
  if (
    scheme.placements.some(
      (placement) =>
        placement.kind === 'sign-post' &&
        !placement.distance &&
        placement.signIds.some((code) => /^1\.25(?:_|$)/.test(code)),
    )
  )
    return null
  const problems: SingleWarningProblem[] = []
  for (const approach of ['left', 'right'] as const) {
    const posts = scheme.placements.filter(
      (placement): placement is Extract<Scheme['placements'][number], { kind: 'sign-post' }> =>
        placement.kind === 'sign-post' &&
        placement.distance?.approach === approach &&
        placement.signIds.some((code) => /^1\.25(?:_|$)/.test(code)),
    )
    if (
      posts.length !== 1 ||
      posts[0]!.signIds.filter((code) => /^1\.25(?:_|$)/.test(code)).length !== 1
    )
      continue
    const post = posts[0]!
    const metres = postMetres(post.distance!, scheme.parameters.signDistancesMetres)
    if (metres === null) continue
    const hasDistancePlate = post.signIds.some((code) => /^8\.1\.1(?:_|$)/.test(code))
    if (metres < range[0] || metres > range[1] || hasDistancePlate)
      problems.push({ approach, postId: post.id, metres, hasDistancePlate })
  }
  return problems.length ? { range, maxSpeedKmh: rules.singleWarningMaxSpeedKmh, problems } : null
}
