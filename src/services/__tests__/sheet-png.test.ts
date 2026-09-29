import { describe, expect, it } from 'vitest'
import { sheetFileName } from '../sheet-png'

describe('sheet file names', () => {
  it('joins parts and removes characters that Windows does not allow', () => {
    expect(sheetFileName(['Схема', 'Б34', '24 км 7 пк', ''], 'png')).toBe(
      'Схема_Б34_24_км_7_пк.png',
    )
    expect(sheetFileName(['ст.Озёрная:53:2/к905'], 'png')).toBe('ст.Озёрная-53-2-к905.png')
    expect(sheetFileName(['  '], 'png')).toBe('Схема.png')
  })
})
