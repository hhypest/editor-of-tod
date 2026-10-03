import type { NormativeRules } from './normative-parameters'

export type WorkTrafficDecision = 'signs' | 'regulators' | 'signals' | 'outside' | 'unknown'

/** Table Д.1 is a set of paired length/traffic conditions, not a single 500 veh/h cutoff. */
export function workTrafficDecision(
  sectionMetres: number | null,
  hourly: number | null,
  limitedVisibility: boolean,
  rules: NormativeRules,
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
  if (sectionMetres < length && hourly <= maximum) return 'regulators'
  if (sectionMetres <= rules.workTraffic.alternateLength && hourly < intensity) return 'signals'
  return 'outside'
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
