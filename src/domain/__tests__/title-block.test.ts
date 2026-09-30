import { describe, expect, it } from 'vitest'
import {
  formatPhone,
  phoneComplete,
  responsibleFromLegacy,
  responsibleLine,
  splitResponsible,
} from '../title-block'

describe('phone mask of responsible persons', () => {
  it('formats pasted numbers in any common form', () => {
    for (const input of ['89101234567', '+7 910 123 45 67', '9101234567', '8 (910) 123-45-67']) {
      expect(formatPhone(input)).toBe('+7 (910) 123-45-67')
    }
    expect(phoneComplete('+7 (910) 123-45-67')).toBe(true)
    expect(phoneComplete('+7 (910) 123-45')).toBe(false)
  })

  it('builds the mask keystroke by keystroke and lets the user erase it', () => {
    let value = ''
    for (const key of '89101234567') value = formatPhone(value + key)
    expect(value).toBe('+7 (910) 123-45-67')
    expect(formatPhone('9')).toBe('+7 (9')
    expect(formatPhone('+7 (910')).toBe('+7 (910')
    expect(formatPhone('+7 (910) 1')).toBe('+7 (910) 1')
    // Стирание: после удаления последней цифры скобка не возвращается.
    expect(formatPhone('+7 (91')).toBe('+7 (91')
    expect(formatPhone('+7 (')).toBe('')
    expect(formatPhone('')).toBe('')
    expect(formatPhone('+7 (910) 123-45-6789')).toBe('+7 (910) 123-45-67')
  })
})

describe('responsible persons from projects before v6', () => {
  it('splits position, full name and phone', () => {
    expect(splitResponsible('начальник участка Фатеев Игорь Леонидович')).toEqual({
      position: 'начальник участка',
      name: 'Фатеев Игорь Леонидович',
      phone: '',
    })
    expect(splitResponsible('дорожный мастер Учебный А.Б., тел. 8-910-123-45-67')).toEqual({
      position: 'дорожный мастер',
      name: 'Учебный А.Б.',
      phone: '+7 (910) 123-45-67',
    })
  })

  it('keeps an unrecognised line in the name field and drops an empty second person', () => {
    expect(responsibleFromLegacy('мастер участка № 3', '')).toEqual([
      { position: '', name: 'мастер участка № 3', phone: '' },
    ])
    expect(responsibleFromLegacy('', '')).toEqual([{ position: '', name: '', phone: '' }])
  })

  it('prints a responsible person on the sheet with the phone', () => {
    expect(
      responsibleLine({ position: 'мастер', name: 'Учебный А.Б.', phone: '+7 (910) 123-45-67' }),
    ).toBe('мастер Учебный А.Б., тел. +7 (910) 123-45-67')
    expect(responsibleLine({ position: '', name: 'Учебный А.Б.', phone: '' })).toBe('Учебный А.Б.')
  })
})
