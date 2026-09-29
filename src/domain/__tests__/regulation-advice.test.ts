import { describe, expect, it } from 'vitest'
import {
  adviseRegulation,
  parseHourly,
  REGULATION_PROFILE,
  type RegulationInput,
} from '../regulation-advice'

const base: RegulationInput = {
  hourly: '180',
  limitedVisibility: false,
  straight: true,
  zoneSpeedKmh: 40,
  taperMetres: 15,
}

describe('B.34 regulation advice', () => {
  it.each([
    ['', false, true, null],
    ['нет', false, true, null],
    ['-5', false, true, null],
    ['249', false, true, 'signs'],
    ['249', true, true, 'two'],
    ['250', false, true, 'one'],
    ['250', false, false, 'two'],
    ['500', false, true, 'one'],
    ['501', false, true, 'one'],
    ['501', false, false, 'two'],
    ['120,5', false, false, 'signs'],
  ] as const)(
    'hourly %s, limited visibility %s, straight %s → %s',
    (hourly, limitedVisibility, straight, mode) => {
      expect(adviseRegulation({ ...base, hourly, limitedVisibility, straight }).mode).toBe(mode)
    },
  )

  it('never substitutes a peak-hour coefficient when intensity is missing', () => {
    const advice = adviseRegulation({ ...base, hourly: '' })
    expect(advice).toMatchObject({ mode: null, hourly: null })
    expect(advice.reasons.join(' ')).toContain('не подставляется')
  })

  it('warns above 500 veh/h without deriving the number of regulators from it', () => {
    const straight = adviseRegulation({ ...base, hourly: '600' })
    expect(straight.mode).toBe('one')
    expect(straight.warnings.join(' ')).toContain('п. 5.4.2')
    expect(straight.warnings.join(' ')).toContain('не выводится')
    expect(adviseRegulation({ ...base, hourly: '400' }).warnings).toEqual([])
  })

  it('cites the clauses behind every recommendation', () => {
    expect(adviseRegulation(base).reasons.join(' ')).toMatch(/пп\. 5\.4\.4, 8\.1\.3\.1/)
    expect(adviseRegulation({ ...base, hourly: '300' }).reasons.join(' ')).toContain('п. 12.7.3')
    expect(
      adviseRegulation({ ...base, hourly: '300', straight: false }).reasons.join(' '),
    ).toContain('пп. 12.7.2–12.7.3')
  })

  it('reminds about the 15 m taper for 2.6/2.7 and the regulator distance from table 5', () => {
    expect(adviseRegulation({ ...base, taperMetres: 10 }).warnings.join(' ')).toContain(
      'отгон 15 м',
    )
    expect(adviseRegulation({ ...base, hourly: '300' }).regulatorDistanceMetres).toBe(15)
    expect(
      adviseRegulation({ ...base, hourly: '300', zoneSpeedKmh: 45 }).regulatorDistanceMetres,
    ).toBeNull()
    expect(adviseRegulation(base).regulatorDistanceMetres).toBeNull()
  })

  it('reads only plain non-negative numbers as intensity', () => {
    expect(parseHourly(' 250 ')).toBe(250)
    expect(parseHourly('12,5')).toBe(12.5)
    expect(parseHourly('1e3')).toBeNull()
    expect(parseHourly('')).toBeNull()
  })

  it('stays unverified until the profile is checked and recorded', () => {
    expect(REGULATION_PROFILE).toMatchObject({ status: 'unverified', verifiedAt: null })
    expect(adviseRegulation(base).verified).toBe(false)
    expect(adviseRegulation({ ...base, hourly: '300' }).reasons.join(' ')).toContain(
      'значение не проверено',
    )
  })
})
