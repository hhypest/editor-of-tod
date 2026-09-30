import { describe, expect, it } from 'vitest'
import { findClause, findTable, normalizeQuote } from '../document-text'

/** Вымышленный документ: колонтитул на каждой странице, оглавление, перенос пункта на страницу. */
const pages = [
  'УЧЕБНЫЙ ДОКУМЕНТ 000-2030\nСодержание\n7.1.2 Учебный пункт ........ 3\n1',
  'УЧЕБНЫЙ ДОКУМЕНТ 000-2030\n7.1.1 Первый пункт без чисел.\n7.1.2 Учебный разъезд допускается на участках\nпротяжен-\nностью менее 40 м с интенсивностью\n2',
  'УЧЕБНЫЙ ДОКУМЕНТ 000-2030\nдвижения менее 300 авт/ч в двух направлениях.\n7.1.3 Следующий пункт.\n3',
  'УЧЕБНЫЙ ДОКУМЕНТ 000-2030\nТ а б л и ц а 9 - Учебная таблица\nСкорость, км/ч Расстояние, м\n30 12\n50 34\n7.2 Раздел после таблицы\n4',
  'УЧЕБНЫЙ ДОКУМЕНТ 000-2030\nСогласно 7.1.2, значения проверяются.\n5',
  'УЧЕБНЫЙ ДОКУМЕНТ 000-2030\nКонец.\n6',
]

describe('clauses in the text of a normative document', () => {
  it('finds a clause across pages without headers, page numbers and the contents line', () => {
    expect(findClause(pages, '7.1.2')).toEqual({
      page: 2,
      text: '7.1.2 Учебный разъезд допускается на участках протяженностью менее 40 м с интенсивностью движения менее 300 авт/ч в двух направлениях.',
    })
  })

  it('does not treat a reference to the clause as its start', () => {
    expect(findClause(pages, '7.1.4')).toBeNull()
    expect(findClause(pages, '7.1')).toBeNull()
  })

  it('returns a table with its rows', () => {
    expect(findTable(pages, '9')).toEqual({
      page: 4,
      text: 'Т а б л и ц а 9 - Учебная таблица Скорость, км/ч Расстояние, м 30 12 50 34',
      rows: ['Скорость, км/ч Расстояние, м', '30 12', '50 34'],
    })
    expect(findTable(pages, '8')).toBeNull()
  })

  it('compares quotes regardless of case, ё, spaces and dashes', () => {
    expect(normalizeQuote('Отгон  15 м — со знаками Ёлка')).toBe(
      normalizeQuote('отгон 15 м-со знаками елка'),
    )
  })
})
