import { describe, it, expect } from 'vitest'
import { adviseRegulation } from '../regulation-advice'
import { PROTOTYPE_RULES, REGULATION_PARAMETERS } from '../normative-parameters'
describe('regulation correction acceptance', () => {
  it.each([249, 250, 500, 501])('requires no separate crossing decision at %s veh/h', (hourly) => {
    const advice = adviseRegulation(
      {
        hourly: String(hourly),
        frontMetres: 21.5,
        sectionMetres: 41.5,
        limitedVisibility: false,
        straight: true,
        taperMetres: 15,
        zoneSpeedKmh: 40,
        workConditions: {
          kind: 'short',
          durationHours: 4,
          daylight: 'day',
          regulatorsPresent: true,
          sectionMetres: 41.5,
        },
      },
      {
        ...PROTOTYPE_RULES,
        confirmed: Object.fromEntries(REGULATION_PARAMETERS.map((id) => [id, true])),
      },
    )
    expect(advice).toMatchObject({
      verified: true,
      unconfirmed: [],
      mode: hourly < 250 ? 'signs' : hourly <= 500 ? 'one' : 'two',
    })
    expect(advice.reasons.join(' ')).not.toContain('решение специалиста')
    expect(advice.warnings.join(' ')).not.toContain('обоснования')
  })
})
