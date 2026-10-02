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
