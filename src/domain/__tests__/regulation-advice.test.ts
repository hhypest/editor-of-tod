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
  sectionMetres: 45,
  workConditions: {
    kind: 'short',
    durationHours: 5,
    daylight: 'day',
    regulatorsPresent: true,
    sectionMetres: null,
  },
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
      documentId: definition.source.kind === 'decision' ? null : 1,
      documentLabel:
        definition.source.kind === 'decision' ? '' : `${definition.source.documentCode}-2030`,
      clause:
        definition.source.kind === 'decision'
          ? ''
          : definition.source.kind === 'table'
            ? definition.source.clause
            : `п. ${definition.source.clause}`,
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
    ['501', false, true, 'two'],
    ['501', false, false, 'two'],
    ['120,5', false, false, 'signs'],
  ] as const)(
    'hourly %s, limited visibility %s, straight %s → %s',
    (hourly, limitedVisibility, straight, mode) => {
      expect(adviseRegulation({ ...base, hourly, limitedVisibility, straight }).mode).toBe(mode)
    },
  )

  it('uses the measured device-length boundary to exclude signs', () => {
    const long = adviseRegulation({ ...base, frontMetres: 25, sectionMetres: 50 })
    expect(long.mode).toBe('two')
    expect(long.warnings.join(' ')).not.toContain('отдельного обоснования')
    expect(long.reasons.join(' ')).toContain('участка — 50 м')
    const unknown = adviseRegulation({ ...base, frontMetres: null, sectionMetres: null })
    expect(unknown.mode).toBeNull()
    expect(unknown.reasons.join(' ')).toContain('фронт работ')
    // Без длины нельзя определить строку таблицы Д.1 даже при высокой интенсивности.
    expect(adviseRegulation({ ...base, hourly: '300', sectionMetres: null })).toMatchObject({
      mode: 'one',
      verified: false,
    })
  })

  it('points to PU-66 and the peak-hour share when intensity is missing', () => {
    const advice = adviseRegulation({ ...base, hourly: '' })
    expect(advice).toMatchObject({ mode: null, hourly: null })
    expect(advice.reasons.join(' ')).toContain('часа пик')
  })

  it('recommends two above 500 and cites the limits of table Д.1', () => {
    const straight = adviseRegulation({ ...base, hourly: '600' })
    expect(straight.mode).toBe('two')
    expect(straight.warnings.join(' ')).toContain('Таблица Д.1')
    expect(straight.reasons.join(' ')).toContain('свыше 500')
    expect(adviseRegulation({ ...base, hourly: '400' }).reasons.join(' ')).toContain('п. 13.7.5')
  })

  it('cites the clauses behind every recommendation', () => {
    expect(adviseRegulation(base).reasons.join(' ')).toContain('ОДМ 218.6.019, п. 6.4.4')
    expect(adviseRegulation({ ...base, hourly: '300' }).reasons.join(' ')).toContain('п. 13.7.5')
    expect(
      adviseRegulation({ ...base, hourly: '300', straight: false }).reasons.join(' '),
    ).toContain('пп. 13.7.3–13.7.5')
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
    expect(advice.unconfirmed).toHaveLength(7)
  })

  it('uses confirmed values of the current edition and cites it', () => {
    const rules = confirmedRules({
      'odm-signs-hourly': 300,
      'gost-work-traffic': {
        'Протяжённость участка для знаков, менее, м': '50',
        'Интенсивность для знаков, менее, авт/ч': '300',
        'Наибольшая протяжённость участка со светофором, м': '300',
        'Наибольшая интенсивность на коротком участке, авт/ч': '500',
      },
      'odm-signs-taper': 12,
      'odm-regulator-distance': { '40': '20' },
    })
    const signs = adviseRegulation({ ...base, hourly: '280', taperMetres: 12 }, rules)
    expect(signs).toMatchObject({ mode: 'signs', verified: true, unconfirmed: [] })
    expect(signs.reasons.join(' ')).toContain('менее 300')
    expect(signs.reasons.join(' ')).toContain('ОДМ 218.6.019-2030, п. 6.4.4')
    expect(signs.warnings).toEqual([])
    expect(adviseRegulation({ ...base, hourly: '310' }, rules).regulatorDistanceMetres).toBe(20)
  })
})
