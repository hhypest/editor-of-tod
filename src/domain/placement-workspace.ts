import { schemeSchema, type Scheme } from './model'
import { postMetres, postScale, snapPostMetres, type PostScale } from './post-distance'
import { zoneAnchors } from './zone-geometry'

type Placement = Scheme['placements'][number]
type Anchor = Placement['position']['anchor']

// Coordinate compatibility for imported v1 projects. These are drawing units,
// not metres or a normative representation of the road.
export const WORKSPACE_WIDTH = 1680
export const WORKSPACE_HEIGHT = 1188

export function anchorCoordinates(scheme: Scheme): Record<Exclude<Anchor, 'abs'>, number> {
  const zone = scheme.parameters.workZones[scheme.template.code]
  if (!zone) throw new Error('Параметры выбранного варианта схемы не заполнены.')
  return zoneAnchors(scheme.template.code, zone, scheme.parameters.regulation.mode === 'signs')
}

export function placementCoordinates(
  placement: Placement,
  anchors: ReturnType<typeof anchorCoordinates>,
  layout?: { scale: PostScale; distances: Scheme['parameters']['signDistancesMetres'] },
): { x: number; y: number } {
  let x =
    placement.position.offsetXSvg +
    (placement.position.anchor === 'abs' ? 0 : anchors[placement.position.anchor]) +
    (placement.kind === 'element'
      ? (placement.position.zoneFraction ?? 0) * (anchors.Z1 - anchors.Z0)
      : 0)
  if (placement.kind === 'sign-post' && placement.distance) {
    // Положение стойки с расстоянием выводится из него, а не из сохранённой координаты.
    if (!layout) throw new Error('Для стойки с расстоянием нужна шкала листа.')
    const metres = postMetres(placement.distance, layout.distances)
    // Поле этапа 2 не заполнено: стойка остаётся на сохранённом месте до ввода расстояния.
    if (metres !== null) x = layout.scale.x(placement.distance.approach, metres)
  }
  const y =
    placement.kind === 'sign-post'
      ? (placement.side === 'up' ? 353 : 567) + placement.position.offsetYSvg
      : placement.position.ySvg
  return { x, y }
}

/** Якоря, шкала расстояний и координаты объектов одной схемы. */
export function schemeLayout(scheme: Scheme) {
  const anchors = anchorCoordinates(scheme)
  const layout = {
    scale: postScale(scheme, anchors),
    distances: scheme.parameters.signDistancesMetres,
  }
  return {
    anchors,
    scale: layout.scale,
    coordinates: (placement: Placement) => placementCoordinates(placement, anchors, layout),
  }
}

export function movePlacement(scheme: Scheme, id: number, deltaX: number, deltaY: number): Scheme {
  if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY)) {
    throw new Error('Смещение объекта должно быть конечным числом.')
  }
  const selected = scheme.placements.find((placement) => placement.id === id)
  if (!selected) throw new Error(`Объект ${id} не найден.`)
  if (deltaX === 0 && deltaY === 0) return scheme

  const placements = scheme.placements.map((placement): Placement => {
    if (placement.id !== id) return placement
    if (placement.kind === 'sign-post') {
      if (placement.distance && deltaX !== 0) {
        // Перенос стойки с расстоянием меняет расстояние, а не условную координату. Стойка,
        // связанная с полем этапа 2, получает собственное значение: поле общее для обоих
        // подходов и меняется на этапе 2.
        const { scale, coordinates } = schemeLayout(scheme)
        const approach = placement.distance.approach
        const metres = snapPostMetres(
          scale.metres(approach, coordinates(placement).x + deltaX),
          scale.stops(approach),
        )
        return {
          ...placement,
          generatedByTemplate: false,
          distance: { by: 'metres', approach, metres },
          position: {
            ...placement.position,
            offsetYSvg: placement.position.offsetYSvg + deltaY,
          },
        }
      }
      return {
        ...placement,
        generatedByTemplate: false,
        position: {
          ...placement.position,
          offsetXSvg: placement.position.offsetXSvg + deltaX,
          offsetYSvg: placement.position.offsetYSvg + deltaY,
        },
      }
    }
    return {
      ...placement,
      generatedByTemplate: false,
      position: {
        ...placement.position,
        offsetXSvg: placement.position.offsetXSvg + deltaX,
        ySvg: placement.position.ySvg + deltaY,
      },
    }
  })

  const result = schemeSchema.safeParse({ ...scheme, placements })
  if (!result.success) throw new Error('Не удалось сохранить положение объекта.')
  return result.data
}

/**
 * Сдвиг стойки с расстоянием на шаг в метрах по экрану: вправо (`screenStepMetres` > 0) или
 * влево. Слева от места работ движение вправо приближает стойку к началу работ, справа —
 * удаляет. Стойка, связанная с полем этапа 2, получает собственное расстояние.
 */
export function stepPostDistance(scheme: Scheme, id: number, screenStepMetres: number): Scheme {
  const selected = scheme.placements.find((placement) => placement.id === id)
  if (!selected || selected.kind !== 'sign-post' || !selected.distance)
    throw new Error(`Стойка ${id} с расстоянием не найдена.`)
  const { approach } = selected.distance
  const current = postMetres(selected.distance, scheme.parameters.signDistancesMetres)
  if (current === null)
    throw new Error('Сначала заполните расстояние этой стойки на этапе 2 или задайте своё.')
  const metres = Math.max(0, current + (approach === 'left' ? -screenStepMetres : screenStepMetres))
  if (metres === current) return scheme
  const result = schemeSchema.safeParse({
    ...scheme,
    placements: scheme.placements.map((placement) =>
      placement.id === id && placement.kind === 'sign-post'
        ? {
            ...placement,
            generatedByTemplate: false,
            distance: { by: 'metres', approach, metres },
          }
        : placement,
    ),
  })
  if (!result.success) throw new Error('Не удалось сохранить расстояние стойки.')
  return result.data
}
