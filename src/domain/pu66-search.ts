/** Поля локального списка карточек, по которым составитель ищет переезд. */
export interface Pu66SearchEntry {
  readonly referenceId: string
  readonly location: string
  readonly roadName: string
  readonly section?: string
  readonly station?: string
}

type Word =
  | { readonly kind: 'kilometre' | 'picket' | 'number'; readonly value: string }
  | { readonly kind: 'text'; readonly value: string }

function normalize(value: string): string {
  return value.toLocaleLowerCase('ru-RU').replaceAll('ё', 'е')
}

/**
 * Разбирает запрос: «53 км 2 пк» — километр и пикет, «53/2» и «53:2» — тоже,
 * отдельные числа и слова ищутся во всех полях записи.
 */
function parseQuery(query: string): Word[] {
  const parts = normalize(query)
    .replace(/(\d+)\s*[/:]\s*(\d+)/g, '$1 км $2 пк')
    .replace(/(\d+)\s*(км|пк)(?![\p{L}])/gu, '$1 $2')
    .split(/[\s,;:/\\()«»"'№.-]+/)
    .filter(Boolean)
  const words: Word[] = []
  parts.forEach((part, index) => {
    if (part === 'км' || part === 'пк' || part === 'ст') return
    const next = parts[index + 1]
    if (/^\d+$/.test(part)) {
      words.push({
        kind: next === 'км' ? 'kilometre' : next === 'пк' ? 'picket' : 'number',
        value: String(Number(part)),
      })
    } else {
      words.push({ kind: 'text', value: part })
    }
  })
  return words
}

function score(entry: Pu66SearchEntry, words: readonly Word[]): number {
  const text = normalize(
    [
      entry.referenceId,
      entry.location,
      entry.roadName,
      entry.section ?? '',
      entry.station ?? '',
    ].join(' '),
  )
  const place = /(\d+)\s*км\s*(\d+)\s*пк/.exec(normalize(entry.location))
  const numbers = (text.match(/\d+/g) ?? []).map((number) => String(Number(number)))
  const parts = text.split(/[^\p{L}\d]+/u)
  let total = 0
  for (const word of words) {
    if (word.kind === 'kilometre' || word.kind === 'picket') {
      // Явно указанные км и пк сравниваются только с местом переезда и только целиком.
      if (place?.[word.kind === 'kilometre' ? 1 : 2] !== word.value) return 0
      total += 4
    } else if (word.kind === 'number') {
      // Число без пометки совпадает с целым числом записи или его началом: «2» находит «2» раньше «24».
      if (numbers.includes(word.value)) total += 3
      else if (numbers.some((number) => number.startsWith(word.value))) total += 1
      else return 0
    } else if (parts.includes(word.value)) {
      total += 3
    } else if (parts.some((part) => part.startsWith(word.value))) {
      total += 2
    } else {
      return 0
    }
  }
  return total
}

/**
 * Отбирает карточки, в которых есть все слова запроса. Слово совпадает с началом слова записи;
 * «N км» и «N пк» — только с местом переезда; точные совпадения выше в списке.
 */
export function searchPu66Cards<T extends Pu66SearchEntry>(
  entries: readonly T[],
  query: string,
): T[] {
  const exact = entries.filter((entry) => normalize(entry.referenceId) === normalize(query.trim()))
  if (exact.length) return exact
  const words = parseQuery(query)
  if (!words.length) return [...entries]
  return entries
    .map((entry, index) => ({ entry, index, value: score(entry, words) }))
    .filter((item) => item.value > 0)
    .sort((a, b) => b.value - a.value || a.index - b.index)
    .map((item) => item.entry)
}
