import type { NormativeRules } from './normative-parameters'
import type { Scheme } from './model'

export type WorkConditions = Scheme['parameters']['workConditions']

export function shortTermWork(
  conditions: WorkConditions | undefined,
  rules: NormativeRules,
): boolean {
  return (
    conditions?.kind === 'short' &&
    conditions.durationHours !== null &&
    conditions.durationHours > 0 &&
    conditions.durationHours <= rules.shortTermHours
  )
}

export type WorkTrafficDecision = 'signs' | 'regulators' | 'signals' | 'outside' | 'unknown'

/** Table Д.1 is a set of paired length/traffic conditions, not a single 500 veh/h cutoff. */
export function workTrafficDecision(
  sectionMetres: number | null,
  hourly: number | null,
  limitedVisibility: boolean,
  rules: NormativeRules,
  conditions?: WorkConditions,
): WorkTrafficDecision {
  if (
    sectionMetres === null ||
    hourly === null ||
    !Number.isFinite(sectionMetres) ||
    sectionMetres <= 0 ||
    !Number.isFinite(hourly) ||
    hourly < 0
  )
    return 'unknown'
  const length = Math.min(rules.signsLengthMetres, rules.workTraffic.signsLength)
  const intensity = Math.min(rules.signsHourly, rules.workTraffic.signsHourly)
  const maximum = Math.min(rules.alternateHourly, rules.workTraffic.alternateHourly)
  if (sectionMetres < length && hourly < intensity)
    return limitedVisibility ? 'regulators' : 'signs'
  if (sectionMetres < length && hourly <= maximum)
    return !conditions || (shortTermWork(conditions, rules) && conditions.regulatorsPresent)
      ? 'regulators'
      : 'signals'
  if (sectionMetres <= rules.workTraffic.alternateLength && hourly < intensity)
    return shortTermWork(conditions, rules) && conditions?.regulatorsPresent
      ? 'regulators'
      : 'signals'
  return 'outside'
}

/** Measured limits take precedence over the provisional sum; neither is the work front. */
export function effectiveWorkSection(
  zone: Parameters<typeof workSectionMetres>[0],
  conditions: WorkConditions,
  variant: 'b33' | 'b34' = 'b34',
): number | null {
  return (
    conditions.sectionMetres ??
    workSectionMetres(
      zone && { ...zone, taperMetres: zone.taperMetres * (variant === 'b33' ? 2 : 1) },
    )
  )
}

/** The profile uses the entered taper + buffer + work zone as the section between devices.
 * The actual device limits and vehicle visibility must still be checked on site.
 */
export function workSectionMetres(
  zone: { taperMetres: number; bufferMetres: number; workMetres: number } | null | undefined,
): number | null {
  if (!zone) return null
  // Та же точность суммы, что у dangerousSectionMetres, без округления до целых метров.
  const length = Number((zone.taperMetres + zone.bufferMetres + zone.workMetres).toFixed(6))
  return Number.isFinite(length) && length > 0 ? length : null
}
