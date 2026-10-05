import { decimalComma } from './number-format.ts'
import { draftTemplateProfile } from './template-profile.ts'
import { zoneAnchors, type ZoneAnchors } from './zone-geometry.ts'

/**
 * Расстояние стойки до начала работ (ADR-0008). Лист остаётся схемой без масштаба (ADR-0003):
 * шкала расставляет стойки по порядку расстояний, а не по метрам на миллиметр.
 *
 * Модуль не зависит от схемы проекта (`model.ts`): им пользуется и миграция формата.
 */

export const DISTANCE_MARKERS = ['d300', 'd250', 'd150', 'd50', 'n100', 'n50'] as const
export type DistanceMarker = (typeof DISTANCE_MARKERS)[number]
/** Подход к месту работ: слева (движение по нижней полосе) или справа (по верхней). */
export type Approach = 'left' | 'right'
/** `marker` — стойка следует за полем расстояния этапа 2; `metres` — собственное число. */
export type PostDistance =
  | { by: 'marker'; approach: Approach; marker: DistanceMarker }
  | { by: 'metres'; approach: Approach; metres: number }

type Distances = Readonly<Record<DistanceMarker, number | null>>
type Anchor = 'abs' | keyof ZoneAnchors
type Zone = { taperMetres: number; bufferMetres: number; workMetres: number }

/** Данные схемы, от которых зависит шкала расстояний. */
export type DistanceLayoutSource = {
  template: { code: 'b33' | 'b34' }
  parameters: {
    location: 'auto' | 'in' | 'out'
    regulation: { mode: 'auto' | 'signs' | 'one' | 'two' }
    signDistancesMetres: Distances
    workZones: { b33: Zone | null; b34: Zone | null }
  }
  placements: ReadonlyArray<{ kind: string; distance?: PostDistance | null }>
}

/** Значения полей расстояний для раскладки, когда поле этапа 2 не заполнено. Не норматив. */
const LAYOUT_FALLBACK: Readonly<Record<DistanceMarker, number>> = {
  d300: 300,
  d250: 250,
  d150: 150,
  d50: 50,
  n100: 100,
  n50: 50,
}

/** Расстояние в метрах; `null` — стойка связана с полем этапа 2, которое не заполнено. */
export function postMetres(distance: PostDistance, distances: Distances): number | null {
  return distance.by === 'metres' ? distance.metres : distances[distance.marker]
}

/** Подпись на выноске стойки: «150 м», «47,5 м», у начала работ — «0». */
export function postCaption(distance: PostDistance, distances: Distances): string {
  const metres = postMetres(distance, distances)
  // Незаполненное поле этапа 2 остаётся маркером: по нему лист не выпускается.
  if (metres === null) return distance.by === 'marker' ? `{${distance.marker}}` : ''
  return metres === 0 ? '0' : `${decimalComma(metres)} м`
}

type Knot = { metres: number; x: number }

export type PostScale = {
  /** Горизонтальная координата стойки на листе. */
  x(approach: Approach, metres: number): number
  /** Расстояние, которому соответствует координата листа (для перетаскивания). */
  metres(approach: Approach, x: number): number
  /** Расстояния, к которым прилипает стойка при перетаскивании. */
  stops(approach: Approach): number[]
  /** Наибольшее расстояние ряда стоек шаблона. */
  templateRange(approach: Approach): number
}

/** Доля ряда стоек шаблона, которая остаётся им, когда есть стойка дальше самой дальней. */
const TEMPLATE_SHARE = 0.7

/** Якоря активной зоны схемы; `null`, если её размеры не заполнены. */
export function layoutAnchors(source: DistanceLayoutSource): ZoneAnchors | null {
  const zone = source.parameters.workZones[source.template.code]
  return zone
    ? zoneAnchors(source.template.code, zone, source.parameters.regulation.mode === 'signs')
    : null
}

function templateKnots(source: DistanceLayoutSource, anchors: ZoneAnchors, approach: Approach) {
  const { parameters, template } = source
  const priority = template.code === 'b34' && parameters.regulation.mode === 'signs'
  const left = approach === 'left'
  const origin = left ? anchors.L0 - 2 : anchors.E + 2
  const base = left ? anchors.L0 : anchors.E
  let markers: DistanceMarker[]
  let offsets: readonly number[]
  if (parameters.location === 'in') {
    const layout = draftTemplateProfile.offsets.settlement[priority ? 'priority' : 'regular']
    markers = ['n50', 'n100']
    offsets = left ? [layout.near, layout.far] : [layout.afterNear, layout.afterFar]
  } else {
    const layout = draftTemplateProfile.offsets.outside[priority ? 'priority' : 'regular']
    markers = ['d50', 'd150', 'd250', 'd300']
    offsets = left ? [...layout.before].reverse() : layout.after
  }
  // Места ряда закреплены компоновкой листа; расстояния занимают их по возрастанию.
  const values = [
    ...new Set(
      markers.map((marker) => parameters.signDistancesMetres[marker] ?? LAYOUT_FALLBACK[marker]),
    ),
  ]
    .filter((value) => value > 0)
    .sort((a, b) => a - b)
  const list: Knot[] = [
    { metres: 0, x: origin },
    ...values.map((metres, index) => ({ metres, x: base + offsets[index]! })),
  ]
  return { list, origin, edge: base + offsets.at(-1)! }
}

function knots(source: DistanceLayoutSource, anchors: ZoneAnchors, approach: Approach): Knot[] {
  const { list, origin, edge } = templateKnots(source, anchors, approach)
  // Стойка дальше самой дальней стойки шаблона: ряд шаблона сжимается к началу работ, а дальние
  // расстояния делят освободившееся место до края ряда.
  const last = list.at(-1)!
  const farthest = Math.max(
    0,
    ...source.placements.flatMap((placement) =>
      placement.distance?.approach === approach
        ? (postMetres(placement.distance, source.parameters.signDistancesMetres) ?? [])
        : [],
    ),
  )
  if (last.metres > 0 && farthest > last.metres) {
    const share = 1 - (1 - TEMPLATE_SHARE) * Math.min(1, (farthest - last.metres) / last.metres)
    for (const knot of list) knot.x = origin + (knot.x - origin) * share
    list.push({ metres: farthest, x: edge })
  }
  return list
}

function interpolate(list: Knot[], value: number, from: 'metres' | 'x', to: 'metres' | 'x') {
  // Список возрастает по метрам; по x он убывает слева и возрастает справа.
  const ascending = list.at(-1)![from] >= list[0]![from]
  const reached = (knot: Knot) => (ascending ? value >= knot[from] : value <= knot[from])
  let index = 0
  while (index < list.length - 2 && reached(list[index + 1]!)) index++
  const a = list[index]!
  const b = list[index + 1]!
  const span = b[from] - a[from]
  return span === 0 ? a[to] : a[to] + ((value - a[from]) / span) * (b[to] - a[to])
}

/** Шкала расстояний листа для обоих подходов. */
export function postScale(source: DistanceLayoutSource, anchors: ZoneAnchors): PostScale {
  const lists = { left: knots(source, anchors, 'left'), right: knots(source, anchors, 'right') }
  const template = {
    left: templateKnots(source, anchors, 'left').list,
    right: templateKnots(source, anchors, 'right').list,
  }
  return {
    x: (approach, metres) =>
      lists[approach].length < 2
        ? lists[approach][0]!.x
        : interpolate(lists[approach], Math.max(0, metres), 'metres', 'x'),
    metres: (approach, x) =>
      lists[approach].length < 2 ? 0 : Math.max(0, interpolate(lists[approach], x, 'x', 'metres')),
    stops: (approach) => template[approach].map((knot) => knot.metres),
    templateRange: (approach) => template[approach].at(-1)!.metres,
  }
}

/**
 * Расстояние после перетаскивания: значение поля этапа 2, если оно рядом, иначе круглое
 * число — до 100 м кратно 5, дальше кратно 10.
 */
export function snapPostMetres(raw: number, stops: readonly number[]): number {
  const value = Math.max(0, raw)
  const near = stops.find((stop) => Math.abs(stop - value) <= Math.max(3, stop * 0.03))
  if (near !== undefined) return near
  const step = value < 100 ? 5 : 10
  return Math.round(value / step) * step
}

/**
 * Расстояние из подписи стойки прежнего формата: единственный маркер поля этапа 2 («{d150}»)
 * или число метров («0», «120 м», «47,5»). Составная и произвольная подпись — `null`.
 */
export function distanceFromLabel(
  label: string | null,
): { by: 'marker'; marker: DistanceMarker } | { by: 'metres'; metres: number } | null {
  const text = label?.trim()
  if (!text) return null
  const marker = /^\{(\w+)\}$/.exec(text)
  if (marker) {
    const key = DISTANCE_MARKERS.find((name) => name === marker[1])
    return key ? { by: 'marker', marker: key } : null
  }
  const metres = /^(\d{1,5}(?:[.,]\d{1,2})?)(?:\s*м\.?)?$/.exec(text)
  return metres ? { by: 'metres', metres: Number(metres[1]!.replace(',', '.')) } : null
}

type LegacyPost = {
  kind: 'sign-post'
  position: { anchor: Anchor; offsetXSvg: number }
  distanceLabel: string | null
}

/** Наибольшее расхождение сохранённого и выведенного положения, при котором стойка не «прыгнет». */
const ADOPTION_TOLERANCE = 3

/**
 * Перевод стоек прежнего формата на расстояния без изменения рисунка. Стойка получает
 * расстояние, только если оно читается из подписи и выведенное из него место совпадает с
 * сохранённым: существующие схемы не перестраиваются молча (ADR-0003). Остальные стойки
 * остаются на условных координатах со своей подписью и попадают в пункт проверки.
 * Подход определяется по положению: левее середины зоны работ — слева, правее — справа.
 */
export function adoptPostDistances<
  Post extends LegacyPost,
  Other extends { kind: string },
  Source extends Omit<DistanceLayoutSource, 'placements'> & {
    placements: ReadonlyArray<Post | Other>
  },
>(source: Source): Array<(Post & { distance: PostDistance | null }) | Other> {
  const isPost = (placement: Post | Other): placement is Post => placement.kind === 'sign-post'
  const anchors = layoutAnchors({ ...source, placements: [] })
  const scale = anchors ? postScale({ ...source, placements: [] }, anchors) : null
  return source.placements.map((placement) => {
    if (!isPost(placement)) return placement
    const free = { ...placement, distance: null }
    const read = distanceFromLabel(placement.distanceLabel)
    if (!read || !anchors || !scale) return free
    const { anchor, offsetXSvg } = placement.position
    const stored = offsetXSvg + (anchor === 'abs' ? 0 : anchors[anchor])
    const approach: Approach = stored < (anchors.L0 + anchors.E) / 2 ? 'left' : 'right'
    // Незаполненное поле этапа 2 занимает на шкале место своего обычного значения: стойка
    // шаблона с таким полем стоит именно там.
    const metres =
      read.by === 'metres'
        ? read.metres
        : (source.parameters.signDistancesMetres[read.marker] ?? LAYOUT_FALLBACK[read.marker])
    // Расстояние за пределами ряда шаблона сжало бы ряд: такая стойка остаётся на месте.
    if (metres > scale.templateRange(approach)) return free
    if (Math.abs(scale.x(approach, metres) - stored) > ADOPTION_TOLERANCE) return free
    return { ...placement, distance: { ...read, approach }, distanceLabel: null }
  })
}
