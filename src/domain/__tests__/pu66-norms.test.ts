import { describe, expect, it } from 'vitest'
import { createUnlinkedScheme } from '../create-scheme'
import { schemeSchema } from '../model'
import {
  checkNorm,
  isDiscrepancy,
  hourlyFromDaily,
  normRows,
  parseNorm,
  typesizeRowForCategory,
} from '../pu66-norms'

describe('PU-66 norm column', () => {
  it.each([
    ['Не менее 10 метров', { kind: 'min', value: 10 }],
    ['не более 50 тысячных', { kind: 'max', value: 50 }],
    ['1000м', { kind: 'exact', value: 1000 }],
    ['16 метров', { kind: 'exact', value: 16 }],
    ['0,75', { kind: 'exact', value: 0.75 }],
    ['не менее 2шт.', { kind: 'min', value: 2 }],
    [3, { kind: 'exact', value: 3 }],
    ['Типовой', null],
    ['Равна ширине проезжей части, но не менее 6 м', { kind: 'min', value: 6 }],
    ['', null],
  ] as const)('reads %s', (norm, expected) => {
    expect(parseNorm(norm)).toEqual(expected)
  })

  it('compares the current value with the norm', () => {
    expect(checkNorm('не менее 100 м', '80')).toBe('below')
    expect(checkNorm('не менее 100 м', 120)).toBe('ok')
    expect(checkNorm('не более 50 тысячных', '60')).toBe('above')
    expect(checkNorm('1000м', '400')).toBe('differs')
    expect(checkNorm('0,75', 0.75)).toBe('ok')
    expect(checkNorm('Типовой', 'Железобетон')).toBe('unknown')
    expect(checkNorm('не менее 6 м', '-')).toBe('unknown')
  })

  it('counts an exact-value mismatch as a discrepancy', () => {
    expect(
      ['ok', 'below', 'above', 'differs', 'unknown'].filter((check) =>
        isDiscrepancy(check as Parameters<typeof isDiscrepancy>[0]),
      ),
    ).toEqual(['below', 'above', 'differs'])
  })

  it('lets a project keep sign size IV suggested for works on IА/IБ roads', () => {
    const scheme = createUnlinkedScheme({
      referenceId: 'TEST-IV',
      locationText: 'Учебный переезд',
      directionLeft: 'А',
      directionRight: 'Б',
      frontMetres: '18',
      taperMetres: '10',
      bufferMetres: '10',
      speedStagesKmh: ['70', '50', '40'],
      yellowTemporarySigns: false,
    })
    const withIv = { ...scheme, parameters: { ...scheme.parameters, signSize: 'IV' as const } }
    expect(schemeSchema.parse(withIv).parameters.signSize).toBe('IV')
  })

  it('drops subheadings, empty rows and the footer of the table', () => {
    const rows = normRows([
      { item: '5', label: 'Видимость', statedNorm: '', previous: '', current: '' },
      {
        item: '5',
        label: 'с правой стороны:',
        statedNorm: 'с правой стороны:',
        previous: '',
        current: '',
      },
      {
        item: '5',
        label: 'нечётного поезда',
        statedNorm: 'не менее 100 м',
        previous: '90',
        current: '90',
      },
      {
        item: '30',
        label: 'Фактические данные внесены учебно',
        statedNorm: 'x',
        previous: 'x',
        current: 'x',
      },
    ])
    expect(rows).toEqual([
      {
        item: '5',
        label: 'нечётного поезда',
        statedNorm: 'не менее 100 м',
        previous: '90',
        current: '90',
        check: 'below',
      },
    ])
  })

  it('converts daily traffic only with a confirmed peak-hour share', () => {
    expect(hourlyFromDaily('3124', 0.1)).toBe(313)
    expect(hourlyFromDaily(1000, null)).toBeNull()
    expect(hourlyFromDaily('нет', 0.1)).toBeNull()
  })

  it('suggests a row of the sign size table by road category', () => {
    expect(typesizeRowForCategory('1Б')).toBe('работы на дорогах IА и IБ категории')
    expect(typesizeRowForCategory('IВ')).toBe('четыре и более полос')
    expect(typesizeRowForCategory('4')).toBe('две и три полосы')
    expect(typesizeRowForCategory('V')).toBe('одна полоса')
    expect(typesizeRowForCategory('2')).toBeNull()
    expect(typesizeRowForCategory(null)).toBeNull()
  })
})
