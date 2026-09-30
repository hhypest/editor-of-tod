/**
 * Сведения ПУ-66 для нормативных подсказок: сравнение фактических значений технической таблицы
 * с графой «Норма», пересчёт суточной интенсивности в часовую по подтверждённой доле часа пик и
 * предварительный выбор строки таблицы типоразмеров по категории дороги.
 */

type Cell = string | number | null

export type Pu66TechnicalRow = {
  item: string
  label: string
  statedNorm: Cell
  previous: Cell
  current: Cell
}

export type Pu66Norms = {
  referenceId: string
  roadCategory: Cell
  carCountPerDay: Cell
  trainCountPerDay: Cell
  trainVisibilityMetres: { rightOdd: Cell; rightEven: Cell; leftOdd: Cell; leftEven: Cell }
  years: { previous: string; current: string }
  technicalRows: Pu66TechnicalRow[]
  revision: number
  updatedAt: string
}

export type ParsedNorm =
  { kind: 'min'; value: number } | { kind: 'max'; value: number } | { kind: 'exact'; value: number }

export type NormCheck = 'ok' | 'below' | 'above' | 'differs' | 'unknown'

function text(value: Cell): string {
  return value === null ? '' : String(value).trim()
}

/** Число из ячейки: «6.6», «0,75», 26; иначе null. */
export function cellNumber(value: Cell): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  const match = /^\s*(\d+(?:[.,]\d+)?)\s*$/u.exec(text(value))
  return match ? Number(match[1]!.replace(',', '.')) : null
}

/**
 * Норма из графы ПУ-66: «не менее 100 м», «не более 50 тысячных», «16 метров», «0,75»,
 * «1000м». Для словесных норм («Типовой», «В соответствии с ПТЭ») возвращается null.
 */
export function parseNorm(value: Cell): ParsedNorm | null {
  if (typeof value === 'number') return { kind: 'exact', value }
  const source = text(value).toLocaleLowerCase('ru-RU').replace(/ё/g, 'е')
  if (!source) return null
  const number = '(\\d+(?:[.,]\\d+)?)'
  const min = new RegExp(`(?:не менее|не меньше|≥|>=)\\s*${number}`, 'u').exec(source)
  if (min) return { kind: 'min', value: Number(min[1]!.replace(',', '.')) }
  const max = new RegExp(`(?:не более|не больше|≤|<=)\\s*${number}`, 'u').exec(source)
  if (max) return { kind: 'max', value: Number(max[1]!.replace(',', '.')) }
  const exact = new RegExp(`^${number}\\s*(?:м|метр(?:а|ов)?|шт\\.?|лк|тысячных)?\\.?$`, 'u').exec(
    source,
  )
  return exact ? { kind: 'exact', value: Number(exact[1]!.replace(',', '.')) } : null
}

export function checkNorm(norm: Cell, current: Cell): NormCheck {
  const parsed = parseNorm(norm)
  const value = cellNumber(current)
  if (!parsed || value === null) return 'unknown'
  if (parsed.kind === 'min') return value < parsed.value ? 'below' : 'ok'
  if (parsed.kind === 'max') return value > parsed.value ? 'above' : 'ok'
  return value === parsed.value ? 'ok' : 'differs'
}

export type NormRow = Pu66TechnicalRow & { check: NormCheck }

/** Числовое расхождение с нормой: меньше, больше или не равно точному значению. */
export function isDiscrepancy(check: NormCheck): boolean {
  return check === 'below' || check === 'above' || check === 'differs'
}

/**
 * Строки таблицы для просмотра: без подзаголовков («с правой стороны:»), пустых строк и
 * отметки о внесении данных в конце таблицы.
 */
export function normRows(rows: readonly Pu66TechnicalRow[]): NormRow[] {
  return rows
    .filter((row) => {
      const norm = text(row.statedNorm)
      if (norm && norm === text(row.label)) return false
      if (!norm && !text(row.current) && !text(row.previous)) return false
      return !text(row.label).startsWith('Фактические данные внесены')
    })
    .map((row) => ({ ...row, check: checkNorm(row.statedNorm, row.current) }))
}

/** Часовая интенсивность из суточной по доле часа пик; округление вверх до целого. */
export function hourlyFromDaily(daily: Cell, share: number | null): number | null {
  const value = cellNumber(daily)
  if (value === null || share === null || share <= 0) return null
  return Math.ceil(value * share)
}

/**
 * Предварительная строка таблицы типоразмеров по категории дороги. Число полос по категории
 * (СП 34.13330) приложение не проверяет: составитель подтверждает строку сам.
 */
export function typesizeRowForCategory(category: Cell): string | null {
  const value = text(category).toUpperCase().replace(/\s+/g, '')
  if (/^(1|I)[АAБ]$/u.test(value)) return 'работы на дорогах IА и IБ категории'
  if (/^(1|I)(В|B)?$/u.test(value)) return 'четыре и более полос'
  if (/^(3|4|III|IV)$/u.test(value)) return 'две и три полосы'
  if (/^(5|V)$/u.test(value)) return 'одна полоса'
  return null
}
