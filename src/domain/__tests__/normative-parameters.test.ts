import { describe, expect, it } from 'vitest'
import {
  parameterDefinition,
  PROTOTYPE_RULES,
  regulationVerified,
  relevantFragment,
  rulesFrom,
  suggestValue,
  valueProblem,
  type ParameterState,
} from '../normative-parameters'

const signs = parameterDefinition('odm-signs-hourly')!
const length = parameterDefinition('odm-signs-length')!
const table = parameterDefinition('odm-regulator-distance')!
const typesize = parameterDefinition('gost-sign-typesize')!
const share = parameterDefinition('peak-hour-share')!

/** Вымышленная формулировка пункта с числами, не текст документа. */
const clause =
  '5.4.4 Учебное условие. Знаки допускаются на участках протяженностью менее 45 м с интенсивностью движения менее 260 авт/ч в двух направлениях. Прочие условия.'

describe('normative parameters', () => {
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
    expect(PROTOTYPE_RULES.sources['odm-signs-hourly']).toBe('ОДМ 218.6.019, п. 5.4.4')
    expect(regulationVerified(PROTOTYPE_RULES)).toBe(false)

    const confirmation = {
      id: 1,
      parameterId: 'odm-signs-hourly',
      documentId: 1,
      documentLabel: 'ОДМ 218.6.019-2030',
      clause: 'п. 5.4.4',
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
    expect(current.sources['odm-signs-hourly']).toBe('ОДМ 218.6.019-2030, п. 5.4.4')
    // Подтверждение по прежней редакции продолжает действовать, но не считается проверенным.
    const previous = rulesFrom([state('same-text')])
    expect(previous.signsHourly).toBe(260)
    expect(previous.confirmed['odm-signs-hourly']).toBe(false)
  })
})
