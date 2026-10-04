import type { NormativeRules } from './normative-parameters'

/** Specialist's railway-crossing profile; this is not table Д.1 of ГОСТ Р 58350. */
export function railRegulationMode(
  input: {
    variant?: 'b33' | 'b34'
    frontMetres: number | null
    hourly: number | null
    limitedVisibility: boolean
    straight: boolean
    daylight: 'unknown' | 'day' | 'night'
  },
  rules: NormativeRules,
): 'signs' | 'one' | 'two' | null {
  const profile = rules.railProfile
  if (
    !Object.values(profile).every((value) => Number.isFinite(value) && value > 0) ||
    profile.signsHourlyInclusive >= profile.oneHourlyInclusive
  )
    return null
  if (
    input.frontMetres === null ||
    !Number.isFinite(input.frontMetres) ||
    input.frontMetres <= 0 ||
    input.frontMetres > rules.railProfile.frontMaximumMetres
  )
    return null
  if (input.variant === 'b33') return 'two'
  if (input.hourly === null || !Number.isFinite(input.hourly) || input.hourly < 0) return null
  if (input.limitedVisibility) return 'two'
  if (input.hourly <= rules.railProfile.signsHourlyInclusive) return 'signs'
  if (
    input.hourly <= rules.railProfile.oneHourlyInclusive &&
    input.straight &&
    input.daylight === 'day'
  )
    return 'one'
  return 'two'
}
