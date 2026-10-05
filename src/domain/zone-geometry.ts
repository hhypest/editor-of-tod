/**
 * Якоря зоны работ на листе в условных единицах 1680 × 1188. Это компоновка рисунка, а не
 * метры на местности и не нормативное представление дороги.
 */
export type ZoneAnchors = Record<'L0' | 'L1' | 'Z0' | 'Z1' | 'E' | 'AX', number>

export function zoneAnchors(
  code: 'b33' | 'b34',
  zone: { taperMetres: number; bufferMetres: number; workMetres: number },
  signsMode: boolean,
): ZoneAnchors {
  const isShortFront = code === 'b34'
  const length = zone.taperMetres * (isShortFront ? 1 : 2) + zone.bufferMetres + zone.workMetres
  const signs = isShortFront && signsMode
  const unitsPerMetre = Math.min(9, (signs ? 470 : 600) / length)
  const start = signs ? 640 : 540
  const taperEnd = start + zone.taperMetres * unitsPerMetre
  const workStart = taperEnd + zone.bufferMetres * unitsPerMetre
  const workEnd = workStart + zone.workMetres * unitsPerMetre
  return {
    L0: start,
    L1: taperEnd,
    Z0: workStart,
    Z1: workEnd,
    E: isShortFront ? workEnd : workEnd + zone.taperMetres * unitsPerMetre,
    AX: (workStart + workEnd) / 2,
  }
}
