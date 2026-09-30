import { describe, expect, it } from 'vitest'
import {
  parameterDefinitions,
  rulesFrom,
  type ParameterState,
  type ParameterValue,
} from '../normative-parameters'
import { adviseRegulation, parseHourly, type RegulationInput } from '../regulation-advice'

const base: RegulationInput = {
  hourly: '180',
  limitedVisibility: false,
  straight: true,
  zoneSpeedKmh: 40,
  taperMetres: 15,
  frontMetres: 20,
}

/** Все параметры подтверждены по вымышленной действующей редакции с заданными значениями. */
function confirmedRules(values: Record<string, ParameterValue> = {}) {
  const states: ParameterState[] = parameterDefinitions.map((definition, index) => ({
    id: definition.id,
    status: { kind: 'confirmed' },
    document: { id: 1, label: 'ОДМ 000-2030', sha256: 'a'.repeat(64) },
    quote: null,
    suggestion: null,
    amendments: [],
    confirmation: {
      id: index + 1,
      parameterId: definition.id,
      documentId: 1,
      documentLabel: 'ОДМ 000-2030',
      clause: 'п. 1',
      page: 1,
      quote: '',
      fragment: '',
      value: values[definition.id] ?? definition.fallback ?? 0.1,
      confirmedBy: 'Учебный составитель',
      confirmedAt: '2030-01-01',
      note: '',
    },
  }))
  return rulesFrom(states)
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

  it('does not allow signs 2.6/2.7 on a work zone of the limit length or longer', () => {
    const long = adviseRegulation({ ...base, frontMetres: 50 })
    expect(long.mode).toBe('one')
    expect(long.reasons.join(' ')).toContain('протяжённость участка работ 50 м')
    const unknown = adviseRegulation({ ...base, frontMetres: null })
    expect(unknown.mode).toBe('signs')
    expect(unknown.warnings.join(' ')).toContain('Укажите протяжённость')
  })

  it('points to PU-66 and the peak-hour share when intensity is missing', () => {
    const advice = adviseRegulation({ ...base, hourly: '' })
    expect(advice).toMatchObject({ mode: null, hourly: null })
    expect(advice.reasons.join(' ')).toContain('часа пик')
  })

  it('warns above 500 veh/h without deriving the number of regulators from it', () => {
    const straight = adviseRegulation({ ...base, hourly: '600' })
    expect(straight.mode).toBe('one')
    expect(straight.warnings.join(' ')).toContain('п. 5.4.2')
    expect(straight.warnings.join(' ')).toContain('не выводится')
    expect(adviseRegulation({ ...base, hourly: '400' }).warnings).toEqual([])
  })

  it('cites the clauses behind every recommendation', () => {
    expect(adviseRegulation(base).reasons.join(' ')).toContain('ОДМ 218.6.019, п. 5.4.4')
    expect(adviseRegulation({ ...base, hourly: '300' }).reasons.join(' ')).toContain('п. 12.7.3')
    expect(
      adviseRegulation({ ...base, hourly: '300', straight: false }).reasons.join(' '),
    ).toContain('пп. 12.7.2–12.7.3')
  })

  it('reminds about the taper for 2.6/2.7 and the regulator distance from the table', () => {
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

  it('stays unverified and names the parameters until they are confirmed', () => {
    const advice = adviseRegulation(base)
    expect(advice.verified).toBe(false)
    expect(advice.unconfirmed).toHaveLength(5)
  })

  it('uses confirmed values of the current edition and cites it', () => {
    const rules = confirmedRules({
      'odm-signs-hourly': 300,
      'odm-signs-taper': 12,
      'odm-regulator-distance': { '40': '20' },
    })
    const signs = adviseRegulation({ ...base, hourly: '280', taperMetres: 12 }, rules)
    expect(signs).toMatchObject({ mode: 'signs', verified: true, unconfirmed: [] })
    expect(signs.reasons.join(' ')).toContain('менее 300 авт./ч')
    expect(signs.reasons.join(' ')).toContain('ОДМ 000-2030, п. 5.4.4')
    expect(signs.warnings).toEqual([])
    expect(adviseRegulation({ ...base, hourly: '310' }, rules).regulatorDistanceMetres).toBe(20)
  })
})
