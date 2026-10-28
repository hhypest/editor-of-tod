import { describe, expect, it } from 'vitest'
import { PROTOTYPE_RULES } from '../normative-parameters'
import { railRegulationMode } from '../rail-regulation'
import { workTrafficDecision } from '../work-traffic'
import { adviseRegulation } from '../regulation-advice'

const base = {
  variant: 'b34' as const,
  frontMetres: 20,
  sectionMetres: 39,
  hourly: 199,
  limitedVisibility: false,
  straight: true,
  daylight: 'day' as const,
}
const conditions = {
  kind: 'short' as const,
  durationHours: 4,
  daylight: 'day' as const,
  regulatorsPresent: true,
  sectionMetres: 39,
}

describe('effective regulation thresholds before consolidation (#137)', () => {
  it.each(['odm', 'gost'] as const)(
    'uses the lower %s bounds in decisions and explanations',
    (lower) => {
      const rules = {
        ...PROTOTYPE_RULES,
        signsHourly: lower === 'odm' ? 200 : 300,
        alternateHourly: lower === 'odm' ? 400 : 600,
        signsLengthMetres: lower === 'odm' ? 40 : 60,
        workTraffic: {
          ...PROTOTYPE_RULES.workTraffic,
          signsHourly: lower === 'gost' ? 200 : 300,
          alternateHourly: lower === 'gost' ? 400 : 600,
          signsLength: lower === 'gost' ? 40 : 60,
        },
      }
      for (const [hourly, expected] of [
        [199, 'signs'],
        [200, 'one'],
        [400, 'one'],
        [401, 'two'],
      ] as const) {
        expect(railRegulationMode({ ...base, hourly }, rules)).toBe(expected)
        const advice = adviseRegulation(
          {
            ...base,
            hourly: String(hourly),
            taperMetres: 15,
            zoneSpeedKmh: 40,
            workConditions: conditions,
          },
          rules,
        )
        expect(advice.mode).toBe(expected)
        expect(advice.reasons[0]).toContain('участке менее 40 м: менее 200')
        expect(advice.reasons[0]).toContain('до 400 включительно')
      }
      expect(railRegulationMode({ ...base, sectionMetres: 40 }, rules)).toBe('two')
      expect(workTrafficDecision(39, 199, false, rules, conditions)).toBe('signs')
      expect(workTrafficDecision(40, 199, false, rules, conditions)).toBe('regulators')
      expect(workTrafficDecision(39, 401, false, rules, conditions)).toBe('outside')
    },
  )

  it.each([0, -1, NaN, Infinity, 500])(
    'retains the rail guard for a signs threshold of %s',
    (signsHourly) => {
      const rules = {
        ...PROTOTYPE_RULES,
        signsHourly,
        workTraffic: { ...PROTOTYPE_RULES.workTraffic, signsHourly },
      }
      expect(railRegulationMode(base, rules)).toBeNull()
    },
  )
})
