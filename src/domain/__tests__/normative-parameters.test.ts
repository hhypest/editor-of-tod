import { describe, expect, it } from 'vitest'
import {
  parameterDefinition,
  PROTOTYPE_RULES,
  regulationVerified,
  relevantFragment,
  rulesFrom,
  suggestValue,
  valueProblem,
  WORK_TRAFFIC_KEYS,
  type ParameterState,
} from '../normative-parameters'

const signs = parameterDefinition('odm-signs-hourly')!
const length = parameterDefinition('odm-signs-length')!
const table = parameterDefinition('odm-regulator-distance')!
const typesize = parameterDefinition('gost-sign-typesize')!
const share = parameterDefinition('peak-hour-share')!

/** Вымышленная формулировка пункта с числами, не текст документа. */
const clause =
  '6.4.4 Учебное условие. Знаки допускаются на участках протяженностью менее 45 м с интенсивностью движения менее 260 авт/ч в двух направлениях. Прочие условия.'

describe('normative parameters', () => {
  it('requires both location rows with an ordered positive range and both plate rows', () => {
    for (const id of ['gost-speed-step-interval', 'gost-warning-distance']) {
      const definition = parameterDefinition(id)!
      if (definition.type !== 'table') throw new Error('Expected table')
      const [outside, settlement] = Object.keys(definition.fallback) as [string, string]
      expect(valueProblem(definition, definition.fallback)).toBeNull()
      expect(valueProblem(definition, { [outside]: '100–150' })).toContain(settlement)
      expect(valueProblem(definition, { [outside]: '100–150', 'В городе': '50–100' })).toContain(
        'подписи строк',
      )
      expect(
        valueProblem(definition, { ...definition.fallback, [settlement]: '150–100' }),
      ).toContain('от меньшего')
      expect(valueProblem(definition, { ...definition.fallback, [outside]: '0–150' })).toContain(
        outside,
      )
    }
    const plates = parameterDefinition('gost-plate-limit')!
    if (plates.type !== 'table') throw new Error('Expected table')
    expect(valueProblem(plates, plates.fallback)).toBeNull()
    expect(valueProblem(plates, { 'С одним знаком': '2' })).toContain('обе строки')
    expect(valueProblem(plates, { ...plates.fallback, 'С одним знаком': '0' })).toContain(
      'Недопустимое значение',
    )
  })

  it('requires the complete paired table with ordered positive bounds', () => {
    const definition = parameterDefinition('gost-work-traffic')!
    if (definition.type !== 'table') throw new Error('Expected table')
    expect(valueProblem(definition, definition.fallback)).toBeNull()
    expect(valueProblem(definition, { [WORK_TRAFFIC_KEYS.signsLength]: '50' })).toContain(
      'все четыре',
    )
    expect(
      valueProblem(definition, {
        ...definition.fallback,
        [WORK_TRAFFIC_KEYS.signsHourly]: '0',
      }),
    ).toContain('положительными')
    expect(
      valueProblem(definition, {
        ...definition.fallback,
        [WORK_TRAFFIC_KEYS.signsLength]: '301',
      }),
    ).toContain('не должны превышать')
    expect(
      valueProblem(definition, {
        ...definition.fallback,
        [WORK_TRAFFIC_KEYS.signsHourly]: '501',
      }),
    ).toContain('не должны превышать')
  })
  it('does not reuse a confirmation after the document or clause was corrected', () => {
    const definition = parameterDefinition('odm-signs-taper')!
    const state: ParameterState = {
      id: definition.id,
      status: { kind: 'confirmed' },
      document: null,
      quote: null,
      suggestion: null,
      amendments: [],
      confirmation: {
        id: 1,
        parameterId: definition.id,
        documentId: 1,
        documentLabel: 'ОДМ 218.6.019-2016',
        clause: 'п. 4.1.8.3',
        page: 1,
        quote: '',
        fragment: '',
        value: 99,
        confirmedBy: 'Учебный составитель',
        confirmedAt: '2030-01-01',
        note: 'Учебное основание',
      },
    }
    const rules = rulesFrom([state])
    expect(rules.signsTaperMetres).toBe(15)
    expect(rules.confirmed[definition.id]).toBe(false)
    expect(rules.sources[definition.id]).toContain('ГОСТ Р 58350')
  })
  it('suggests values found in the clause text', () => {
    expect(suggestValue(signs, { text: clause })).toBe(260)
    expect(suggestValue(length, { text: clause })).toBe(45)
    expect(suggestValue(signs, { text: 'Другой текст.' })).toBeNull()
    expect(suggestValue(signs, null)).toBeNull()
    expect(
      suggestValue(table, { text: '', rows: ['Скорость, км/ч', '30 12', '50 34', 'Примечание'] }),
    ).toEqual({ '30': '12', '50': '34' })
    expect(suggestValue(typesize, { text: 'Таблица 1', rows: ['I 1 Дороги'] })).toBeNull()
  })

  it('extracts the signs taper from the wording of table И.1 note 3', () => {
    const definition = parameterDefinition('odm-signs-taper')!
    // Вымышленное значение, короткий фрагмент формулировки вместо текста стандарта.
    expect(
      suggestValue(definition, {
        text: 'Учебная таблица: 17 м при регулировании с помощью знаков 2.6 и 2.7.',
      }),
    ).toBe(17)
    expect(
      suggestValue(definition, { text: 'Учебная таблица: 18 м - с помощью знаков 2.6 и 2.7.' }),
    ).toBe(18)
  })

  it('compares editions by the sentence with the value', () => {
    expect(relevantFragment(signs, clause)).toBe(
      'знаки допускаются на участках протяженностью менее 45 м с интенсивностью движения менее 260 авт/ч в двух направлениях.',
    )
    expect(relevantFragment(signs, clause.replace('Прочие условия.', 'Иные условия.'))).toBe(
      relevantFragment(signs, clause),
    )
  })

  it('validates values by the parameter description', () => {
    expect(valueProblem(signs, 250)).toBeNull()
    expect(valueProblem(signs, 0)).toContain('от 1')
    expect(valueProblem(signs, { '30': '10' })).toBe('Нужно число.')
    expect(valueProblem(table, { '30': '10' })).toBeNull()
    expect(valueProblem(table, { '30': 'десять' })).toContain('десять')
    expect(valueProblem(typesize, { 'две и три полосы': 'V' })).toContain('V')
    expect(valueProblem(share, 0.1)).toBeNull()
    expect(valueProblem(share, 2)).toContain('до 1')
  })

  it('uses prototype values until parameters are confirmed for the current edition', () => {
    expect(PROTOTYPE_RULES).toMatchObject({
      signsHourly: 250,
      signsLengthMetres: 50,
      alternateHourly: 500,
      signsTaperMetres: 15,
      speedStepKmh: 20,
      peakHourShare: null,
    })
    expect(PROTOTYPE_RULES.regulatorDistance[40]).toBe(15)
    expect(PROTOTYPE_RULES.sources['odm-signs-hourly']).toBe('ОДМ 218.6.019, п. 6.4.4')
    expect(regulationVerified(PROTOTYPE_RULES)).toBe(false)

    const confirmation = {
      id: 1,
      parameterId: 'odm-signs-hourly',
      documentId: 1,
      documentLabel: 'ОДМ 218.6.019-2030',
      clause: 'п. 6.4.4',
      page: 3,
      quote: clause,
      fragment: relevantFragment(signs, clause),
      value: 260,
      confirmedBy: 'Учебный составитель',
      confirmedAt: '2030-02-01',
      note: '',
    }
    const state = (kind: 'confirmed' | 'same-text'): ParameterState => ({
      id: 'odm-signs-hourly',
      status: kind === 'confirmed' ? { kind } : { kind, previous: 'ОДМ 218.6.019-2030' },
      document: { id: 2, label: 'ОДМ 218.6.019-2031', sha256: 'b'.repeat(64) },
      quote: null,
      suggestion: null,
      confirmation,
      amendments: [],
    })
    const current = rulesFrom([state('confirmed')])
    expect(current.signsHourly).toBe(260)
    expect(current.confirmed['odm-signs-hourly']).toBe(true)
    expect(current.sources['odm-signs-hourly']).toBe('ОДМ 218.6.019-2030, п. 6.4.4')
    // Подтверждение по прежней редакции продолжает действовать, но не считается проверенным.
    const previous = rulesFrom([state('same-text')])
    expect(previous.signsHourly).toBe(260)
    expect(previous.confirmed['odm-signs-hourly']).toBe(false)
  })
})
