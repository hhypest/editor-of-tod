/**
 * Имя PNG в архиве: знак 3.24 со значением 50 хранится как «3.24» («3.24_ж»),
 * остальные значения — как «3.24_70». Код проекта не меняется, меняется только файл.
 */
export function signImageCode(code: string, available: ReadonlySet<string>): string {
  if (available.has(code)) return code
  const speed = /^3\.24_50(_ж)?$/.exec(code)
  if (speed && available.has(`3.24${speed[1] ?? ''}`)) return `3.24${speed[1] ?? ''}`
  return code
}

/** Табличка 8.2.1 «Зона действия» с протяжённостью, м: «8.2.1_47», «8.2.1_38.5». */
export const ZONE_PLATE = /^8\.2\.1_(\d+(?:\.\d+)?)$/

/**
 * Знаки, которые можно нарисовать без PNG: ограничение скорости, табличка расстояния 8.1.1 и
 * табличка зоны действия 8.2.1 с протяжённостью.
 */
export function drawableWithoutImage(code: string): boolean {
  return /^3\.24(_\d+)?(_ж)?$/.test(code) || /^8\.1\.1_\d+$/.test(code) || ZONE_PLATE.test(code)
}

/**
 * Изображение-основа знака, который программа дорисовывает: 3.24 с другим числом рисуется
 * поверх изображения 3.24 (3.24_ж) из каталога ГОСТ Р 52290, табличка 8.1.1 с другим
 * расстоянием — поверх 8.1.1, табличка 8.2.1 с протяжённостью — поверх 8.2.1 (стрелки остаются
 * из стандарта). Кайма, кольцо и фон берутся из стандарта, заменяется число.
 */
export function drawnSignBase(code: string): string | null {
  const speed = /^3\.24(?:_\d+)?(_ж)?$/.exec(code)
  if (speed) return `3.24${speed[1] ?? ''}`
  if (/^8\.1\.1_\d+$/.test(code)) return '8.1.1'
  return ZONE_PLATE.test(code) ? '8.2.1' : null
}

/** Знак дополнительной информации (табличка); 8.22 — знаки «Препятствие», не таблички. */
export function isPlate(code: string): boolean {
  return code.startsWith('8.') && !code.startsWith('8.22')
}

/**
 * Столбцы стойки слева направо: знак и таблички под ним. Табличка относится к знаку, с
 * которым применена, и размещается непосредственно под ним (ГОСТ Р 52289-2019, п. 5.9.1).
 * В списке знаков стойки табличка принадлежит предыдущему знаку; табличка 8.2.1 — соседнему
 * знаку 1.25, с которым её ставит шаблон (п. 5.9.5), даже если он записан после неё. Стойка из
 * одних табличек рисует каждую отдельным столбцом.
 */
export function postColumns(signIds: readonly string[]): number[][] {
  const columns = new Map<number, number[]>()
  const loose: number[][] = []
  const main = (from: number, step: 1 | -1): number | null => {
    for (let index = from; index >= 0 && index < signIds.length; index += step)
      if (!isPlate(signIds[index]!)) return index
    return null
  }
  signIds.forEach((code, index) => {
    if (!isPlate(code)) columns.set(index, [index])
  })
  signIds.forEach((code, index) => {
    if (!isPlate(code)) return
    const previous = main(index - 1, -1)
    const next = main(index + 1, 1)
    const warning = (target: number | null) =>
      target !== null && /^1\.25(_|$)/.test(signIds[target]!)
    const owner =
      /^8\.2\.1(_|$)/.test(code) && warning(next) && !warning(previous) ? next : (previous ?? next)
    if (owner === null) loose.push([index])
    else columns.get(owner)!.push(index)
  })
  return [...[...columns.entries()].sort(([a], [b]) => a - b).map(([, items]) => items), ...loose]
}
