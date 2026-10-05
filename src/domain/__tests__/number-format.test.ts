import { describe, expect, it } from 'vitest'
import { decimalComma, decimalCommaInMeasures } from '../number-format'

describe('numbers on the sheet', () => {
  it('uses a decimal comma and leaves other text alone', () => {
    expect(decimalComma(7.9)).toBe('7,9')
    expect(decimalComma(40)).toBe('40')
    expect(decimalComma('6.5')).toBe('6,5')
    expect(decimalComma('6,10')).toBe('6,10')
    expect(decimalComma('47.5 м / 0.5 км')).toBe('47,5 м / 0,5 км')
    // Точка в конце предложения и сокращения не затрагиваются.
    expect(decimalComma('до 5 м. Далее')).toBe('до 5 м. Далее')
  })

  it('changes only measures in a caption typed by the author', () => {
    expect(decimalCommaInMeasures('0.5 км')).toBe('0,5 км')
    expect(decimalCommaInMeasures('47.5м / 120 м')).toBe('47,5м / 120 м')
    // Ссылки на пункты и номера знаков остаются как введены.
    expect(decimalCommaInMeasures('50 м (ГОСТ Р 52289-2019, п. 5.2.2)')).toBe(
      '50 м (ГОСТ Р 52289-2019, п. 5.2.2)',
    )
    expect(decimalCommaInMeasures('знак 1.25, 3.24 место')).toBe('знак 1.25, 3.24 место')
    expect(decimalCommaInMeasures('7.5 мин')).toBe('7.5 мин')
  })
})
