import { describe, expect, it } from 'vitest'
import { PROTOTYPE_RULES } from '../normative-parameters'
import { workSectionMetres, workTrafficDecision } from '../work-traffic'

describe('paired length/traffic conditions of GOST R 58350 table Д.1', () => {
  it.each([
    [49, 249, false, 'signs'],
    [49, 249, true, 'regulators'],
    [49, 250, false, 'regulators'],
    [49, 500, false, 'regulators'],
    [49, 501, false, 'outside'],
    [50, 249, false, 'signals'],
    [300, 249, false, 'signals'],
    [301, 249, false, 'outside'],
    [50, 250, false, 'outside'],
    [300, 500, false, 'outside'],
    [null, 250, false, 'unknown'],
    [20, null, false, 'unknown'],
    [0, 100, false, 'unknown'],
  ] as const)(
    '%s m / %s veh/h / visibility limited %s → %s',
    (length, hourly, limited, decision) => {
      expect(workTrafficDecision(length, hourly, limited, PROTOTYPE_RULES)).toBe(decision)
    },
  )

  it('uses the complete entered section and never equates it with the work front', () => {
    const length = workSectionMetres({ taperMetres: 15, bufferMetres: 10, workMetres: 25 })
    expect(length).toBe(50)
    expect(workTrafficDecision(length, 200, false, PROTOTYPE_RULES)).toBe('signals')
    expect(workSectionMetres(null)).toBeNull()
  })

  it('keeps the stricter condition when independently confirmed ODM and GOST bounds differ', () => {
    const rules = { ...PROTOTYPE_RULES, signsHourly: 300 }
    expect(workTrafficDecision(40, 280, false, rules)).toBe('regulators')
    expect(
      workTrafficDecision(40, 280, false, {
        ...rules,
        workTraffic: { ...rules.workTraffic, signsHourly: 200 },
      }),
    ).toBe('regulators')
  })
})
