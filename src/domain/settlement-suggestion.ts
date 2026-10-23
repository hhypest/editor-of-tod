import type { Scheme } from './model'

export type SettlementSuggestion = {
  location: 'in'
  /** Фрагмент названия дороги, из-за которого показано предположение. */
  marker: string
}

const SETTLEMENT_MARKERS = [
  /(?:^|[^\p{L}])ул(?:ица)?\.?(?=$|[^\p{L}])/iu,
  /(?:^|[^\p{L}])(?:переулок|пер)\.(?=$|[^\p{L}])/iu,
  /(?:^|[^\p{L}])переулок(?=$|[^\p{L}])/iu,
  /(?:^|[^\p{L}])(?:проспект|просп|пр-т)\.?(?=$|[^\p{L}])/iu,
  /(?:^|[^\p{L}])(?:бульвар|б-р)\.?(?=$|[^\p{L}])/iu,
  /(?:^|[^\p{L}])(?:набережная|наб)\.?(?=$|[^\p{L}])/iu,
  /(?:^|[^\p{L}])(?:площадь|пл)\.?(?=$|[^\p{L}])/iu,
  /(?:^|[^\p{L}])(?:проезд|тупик|аллея|линия)(?=$|[^\p{L}])/iu,
  /(?:^|[^\p{L}])(?:город|г|посёлок|поселок|пос|село|с|деревня|д)\.(?=$|[^\p{L}])/iu,
  /(?:^|[^\p{L}])(?:город|посёлок|поселок|село|деревня)(?=$|[^\p{L}])/iu,
] as const

/**
 * Предположение по названию дороги из ПУ-66, а не классификация места работ. Название может
 * описывать дорогу целиком, поэтому результат применяется только явной кнопкой составителя.
 */
export function settlementSuggestion(roadName: string): SettlementSuggestion | null {
  const normalized = roadName.trim().toLocaleLowerCase('ru-RU').replaceAll('ё', 'е')
  if (!normalized) return null
  const match = SETTLEMENT_MARKERS.map((pattern) => pattern.exec(normalized)).find(Boolean)
  if (!match) return null
  const marker = match[0].trim().replace(/^[^\p{L}]+|[^\p{L}.-]+$/gu, '')
  return { location: 'in', marker: marker || match[0].trim() }
}

/** Подсказка доступна только для дороги из закреплённого снимка ПУ-66. */
export function schemeSettlementSuggestion(scheme: Scheme): SettlementSuggestion | null {
  return scheme.crossing.source === 'local-pu66'
    ? settlementSuggestion(scheme.crossing.snapshot.roadName)
    : null
}
