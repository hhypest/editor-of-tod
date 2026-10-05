import { describe, expect, it } from 'vitest'
import { decimalComma } from '../number-format'

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
})
