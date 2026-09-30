/**
 * Поиск пунктов и таблиц в тексте нормативного документа (страницы, строки через «\n»).
 * Колонтитулы — строки, которые повторяются на многих страницах, — в цитату не попадают.
 */

export type ClauseQuote = {
  /** Номер страницы PDF, на которой начинается пункт. */
  page: number
  /** Текст пункта одной строкой: переносы строк заменены пробелами, переносы слов склеены. */
  text: string
}

type Line = { page: number; text: string }

const CLAUSE_START = /^\d+(?:\.\d+)+\.?\s+\S/u
const TABLE_START = /^Т\s*а\s*б\s*л\s*и\s*ц\s*а\s+[А-ЯA-Z]?\s*\.?\s*\d/u
const MAX_LINES = 40

function shape(line: string): string {
  return line.replace(/\d+/g, '#').trim()
}

/** Строки документа без колонтитулов и номеров страниц. */
function bodyLines(pages: readonly string[]): Line[] {
  const counts = new Map<string, number>()
  const split = pages.map((page) => page.split('\n').map((line) => line.trim()))
  for (const lines of split)
    for (const key of new Set(lines.map(shape))) counts.set(key, (counts.get(key) ?? 0) + 1)
  const repeated = Math.max(5, Math.ceil(pages.length * 0.3))
  return split.flatMap((lines, index) =>
    lines
      .filter(
        (line) => line && !/^\d{1,4}$/.test(line) && (counts.get(shape(line)) ?? 0) < repeated,
      )
      .map((text) => ({ page: index + 1, text })),
  )
}

function joinLines(lines: readonly string[]): string {
  let text = ''
  for (const line of lines) {
    if (!text) text = line
    // «протяжен-» + «ностью»: перенос слова внутри абзаца.
    else if (/\p{L}-$/u.test(text) && /^\p{Ll}/u.test(line)) text = text.slice(0, -1) + line
    else text += ` ${line}`
  }
  return text.replace(/\s+/g, ' ').trim()
}

function tableNumber(line: string): string | null {
  const match = /^Т\s*а\s*б\s*л\s*и\s*ц\s*а\s+([А-ЯA-Z]?)\s*\.?\s*(\d+(?:\.\d+)?)/u.exec(line)
  return match ? `${match[1] ? `${match[1]}.` : ''}${match[2]}` : null
}

function extract(lines: readonly Line[], start: number, stop: (line: string) => boolean) {
  const taken = [lines[start]!.text]
  for (let index = start + 1; index < lines.length && taken.length < MAX_LINES; index++) {
    if (stop(lines[index]!.text)) break
    taken.push(lines[index]!.text)
  }
  return taken
}

/**
 * Пункт по номеру («5.4.4», «4.1.8.3»): от строки, которая начинается с номера, до следующего
 * пункта или таблицы. Строки оглавления (с многоточием) пропускаются; если совпадений несколько,
 * берётся самое длинное.
 */
export function findClause(pages: readonly string[], clause: string): ClauseQuote | null {
  const lines = bodyLines(pages)
  const escaped = clause.replace(/\./g, '\\.')
  const head = new RegExp(`^${escaped}\\.?\\s+(?![\\d,])\\S`, 'u')
  let best: ClauseQuote | null = null
  lines.forEach((line, index) => {
    if (!head.test(line.text) || /\.{4,}|…{2,}/.test(line.text)) return
    const text = joinLines(
      extract(lines, index, (next) => CLAUSE_START.test(next) || TABLE_START.test(next)),
    )
    if (!best || text.length > best.text.length) best = { page: line.page, text }
  })
  return best
}

/**
 * Таблица по номеру («5», «1», «А.1»): заголовок «Таблица N — …» и строки до следующего пункта
 * или таблицы. Строки таблицы возвращаются отдельно, чтобы можно было разобрать значения.
 */
export function findTable(
  pages: readonly string[],
  number: string,
): (ClauseQuote & { rows: string[] }) | null {
  const lines = bodyLines(pages)
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!
    if (tableNumber(line.text) !== number || /\.{4,}/.test(line.text)) continue
    const taken = extract(lines, index, (next) => CLAUSE_START.test(next) || TABLE_START.test(next))
    return { page: line.page, text: joinLines(taken), rows: taken.slice(1) }
  }
  return null
}

/** Текст для сравнения редакций: регистр, «ё», пробелы и тире не учитываются. */
export function normalizeQuote(text: string): string {
  return text
    .toLocaleLowerCase('ru-RU')
    .replace(/ё/g, 'е')
    .replace(/[‐-―−]/g, '-')
    .replace(/\s*-\s*/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
}
