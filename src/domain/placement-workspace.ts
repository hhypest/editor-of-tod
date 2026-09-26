import { schemeSchema, type Scheme } from './model'

type Placement = Scheme['placements'][number]
type Anchor = Placement['position']['anchor']

// Coordinate compatibility for imported v1 projects. These are drawing units,
// not metres or a normative representation of the road.
export const WORKSPACE_WIDTH = 1680
export const WORKSPACE_HEIGHT = 1188

export function anchorCoordinates(scheme: Scheme): Record<Exclude<Anchor, 'abs'>, number> {
  const zone = scheme.parameters.workZones[scheme.template.code]
  if (!zone) throw new Error('Параметры выбранного варианта схемы не заполнены.')
  const isShortFront = scheme.template.code === 'b34'
  const length = zone.taperMetres * (isShortFront ? 1 : 2) + zone.bufferMetres + zone.workMetres
  const unitsPerMetre = Math.min(9, 600 / length)
  const start = 540
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

export function placementCoordinates(
  placement: Placement,
  anchors: ReturnType<typeof anchorCoordinates>,
): { x: number; y: number } {
  const x =
    placement.position.offsetXSvg +
    (placement.position.anchor === 'abs' ? 0 : anchors[placement.position.anchor])
  const y =
    placement.kind === 'sign-post'
      ? (placement.side === 'up' ? 353 : 567) + placement.position.offsetYSvg
      : placement.position.ySvg
  return { x, y }
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
