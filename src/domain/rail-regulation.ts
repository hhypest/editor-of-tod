import { regulationThresholds } from './regulation-thresholds'
import type { NormativeRules } from './normative-parameters'

/** ГОСТ Р 58350-2019, Д.1 and ОДМ 218.6.019-2016, 6.4, 7.3.1, 13.7.5.
 * Д.1 governs signs/signals, not the number of staff. For the short-work templates,
 * one is recommended only in the middle band with all visibility/daylight conditions;
 * two are retained for B.33, limited visibility and the higher traffic band.
 */
export function railRegulationMode(
  input: {
    variant?: 'b33' | 'b34'
    frontMetres: number | null
    sectionMetres: number | null
    hourly: number | null
    limitedVisibility: boolean
    straight: boolean
    daylight: 'unknown' | 'day' | 'night'
  },
  rules: NormativeRules,
): 'signs' | 'one' | 'two' | null {
  const {
    signsHourly: signs,
    alternateHourly: one,
    signsLengthMetres: length,
  } = regulationThresholds(rules)
  if (![signs, one, length].every((v) => Number.isFinite(v) && v > 0) || signs >= one) return null
  if (
    input.frontMetres === null ||
    !Number.isFinite(input.frontMetres) ||
    input.frontMetres <= 0 ||
    input.frontMetres > rules.frontLimitMetres
  )
    return null
  if (input.variant === 'b33') return 'two'
  if (input.hourly === null || !Number.isFinite(input.hourly) || input.hourly < 0) return null
  if (input.limitedVisibility) return 'two'
  if (
    input.sectionMetres !== null &&
    (!Number.isFinite(input.sectionMetres) || input.sectionMetres < input.frontMetres)
  )
    return null
  if (input.hourly < signs) {
    if (input.sectionMetres === null) return null
    return input.sectionMetres < length ? 'signs' : 'two'
  }
  if (
    input.hourly <= one &&
    (input.sectionMetres === null || input.sectionMetres < length) &&
    input.straight &&
    input.daylight === 'day'
  )
    return 'one'
  return 'two'
}
