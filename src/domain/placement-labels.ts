import type { Scheme } from './model'

type Placement = Scheme['placements'][number]
type Anchor = Placement['position']['anchor']
type SignPost = Extract<Placement, { kind: 'sign-post' }>
type ElementKind = Extract<Placement, { kind: 'element' }>['elementKind']

/**
 * Русские подписи служебных значений объекта. В проекте хранятся коды (`L0`, `down`, `right`),
 * составитель видит их расшифровку. Код привязки оставлен в подписи: теми же обозначениями
 * подписаны вертикальные направляющие рабочей области.
 */
export const anchorLabels: Readonly<Record<Anchor, string>> = {
  abs: 'Без привязки (координаты листа)',
  L0: 'L0 — начало отвода',
  L1: 'L1 — конец отвода',
  Z0: 'Z0 — начало фронта работ',
  Z1: 'Z1 — конец фронта работ',
  E: 'E — конец зоны работ',
  AX: 'AX — середина фронта (ось переезда)',
}

export const sideLabels: Readonly<Record<SignPost['side'], string>> = {
  up: 'Над дорогой',
  down: 'Под дорогой',
}

export const standLabels: Readonly<Record<SignPost['stand'], string>> = {
  left: 'Слева от знаков',
  right: 'Справа от знаков',
}

export const elementLabels: Readonly<Record<ElementKind, string>> = {
  reg: 'Регулировщик',
  cone: 'Конус',
  car: 'Автомобиль прикрытия',
  complex: 'Переносной комплекс',
  pit: 'Место работ',
  text: 'Надпись',
}

/** Короткое название объекта для списков: «Стойка 1.25, 8.2.1», «Конус», «Надпись …». */
export function placementTitle(placement: Placement): string {
  if (placement.kind === 'sign-post') return `Стойка ${placement.signIds.join(', ')}`
  if (placement.elementKind === 'text') return `Надпись ${placement.text ?? ''}`.trim()
  return elementLabels[placement.elementKind]
}
