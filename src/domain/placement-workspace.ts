import { roadDrawingNodes } from './road-automation-state'
import { schemeSchema, type Scheme } from './model'
import { postMetres, postScale, snapPostMetres, type PostScale } from './post-distance'
import { zoneAnchors } from './zone-geometry'
import { projectRoadSheet } from './road-sheet'
import { branchPostPositions } from './branch-post-geometry'
import { markRoadCalculationEdited } from './road-calculation-state'

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
    scale: postScale(
      {
        ...scheme,
        placements: [
          ...scheme.placements,
          ...(scheme.roadObjectExclusions?.objects ?? []).map((item) => item.post),
        ],
      },
      anchors,
    ),
    distances: scheme.parameters.signDistancesMetres,
  }
  const branches = branchPostPositions(
    scheme.roadLayout,
    projectRoadSheet(roadDrawingNodes(scheme), anchors, layout.scale).nodes,
  )
  for (const item of scheme.roadLayout.detached ?? [])
    if (!branches.has(item.placementId))
      branches.set(item.placementId, {
        x: item.x,
        y: item.y,
        rotation: item.rotation,
        nodeId: item.nodeId,
        link: item.previousLink,
      })
  return {
    anchors,
    scale: layout.scale,
    branch: (id: number) => branches.get(id),
    drawingScale: (id: number) =>
      scheme.roadLayout.automation?.layoutPositions?.find((p) => p.placementId === id)?.scale ?? 1,
    coordinates: (placement: Placement) =>
      branches.get(placement.id) ??
      scheme.roadLayout.automation?.layoutPositions?.find((p) => p.placementId === placement.id) ??
      placementCoordinates(placement, anchors, layout),
  }
}

export function movePlacement(scheme: Scheme, id: number, deltaX: number, deltaY: number): Scheme {
  if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY)) {
    throw new Error('Смещение объекта должно быть конечным числом.')
  }
  const selected = scheme.placements.find((placement) => placement.id === id)
  if (!selected) throw new Error(`Объект ${id} не найден.`)
  if (deltaX === 0 && deltaY === 0) return scheme
  const detached = scheme.roadLayout.detached?.find((item) => item.placementId === id)
  if (detached)
    return schemeSchema.parse({
      ...scheme,
      roadLayout: {
        ...scheme.roadLayout,
        detached: scheme.roadLayout.detached!.map((item) =>
          item.placementId === id ? { ...item, x: item.x + deltaX, y: item.y + deltaY } : item,
        ),
      },
    })
  const packed = scheme.roadLayout.automation?.layoutPositions?.find((p) => p.placementId === id)
  if (packed)
    return schemeSchema.parse({
      ...scheme,
      placements: scheme.placements.map((p) =>
        p.id === id ? { ...p, generatedByTemplate: false } : p,
      ),
      roadLayout: {
        ...markRoadCalculationEdited(scheme.roadLayout, id),
        automation: {
          ...scheme.roadLayout.automation!,
          layoutPositions: scheme.roadLayout.automation!.layoutPositions!.map((p) =>
            p.placementId === id ? { ...p, x: p.x + deltaX, y: p.y + deltaY } : p,
          ),
        },
      },
    })
  const attached = scheme.roadLayout.links.find(
    (link) => link.placementId === id && link.branchPlacement,
  )
  if (attached?.branchPlacement) {
    const branch = attached.branchPlacement
    const alongSvg = branch.alongSvg + (branch.branch === 'up' ? -deltaY : deltaY)
    if (alongSvg < 0)
      throw new Error('Для переноса за ось узла выберите другую ветвь в свойствах стойки.')
    const result = schemeSchema.safeParse({
      ...scheme,
      placements: scheme.placements.map((item) =>
        item.id === id ? { ...item, generatedByTemplate: false } : item,
      ),
      roadLayout: markRoadCalculationEdited(
        {
          ...scheme.roadLayout,
          links: scheme.roadLayout.links.map((link) =>
            link.placementId === id
              ? {
                  ...link,
                  origin: 'manual',
                  branchPlacement: { ...branch, alongSvg, acrossSvg: branch.acrossSvg + deltaX },
                }
              : link,
          ),
        },
        id,
      ),
    })
    if (!result.success) throw new Error('Смещение выходит за допустимые условные границы рисунка.')
    return result.data
  }

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

  const result = schemeSchema.safeParse({
    ...scheme,
    placements,
    roadLayout: markRoadCalculationEdited(scheme.roadLayout, id),
  })
  if (!result.success) throw new Error('Не удалось сохранить положение объекта.')
  return result.data
}

/**
 * Сдвиг стойки с расстоянием на шаг в метрах по экрану: вправо (`screenStepMetres` > 0) или
 * влево. Слева от места работ движение вправо приближает стойку к началу работ, справа —
 * удаляет. Стойка, связанная с полем этапа 2, получает собственное расстояние.
 */
export function stepPostDistance(scheme: Scheme, id: number, screenStepMetres: number): Scheme {
  if (scheme.roadLayout.detached?.some((item) => item.placementId === id))
    throw new Error(
      'Отсоединённая стойка перемещается в условных единицах; сначала задайте новую связь.',
    )
  if (scheme.roadLayout.links.some((link) => link.placementId === id && link.branchPlacement))
    throw new Error(
      'Стойка на ветви перемещается в условных единицах; замер установки редактируется отдельно.',
    )
  const selected = scheme.placements.find((placement) => placement.id === id)
  if (!selected || selected.kind !== 'sign-post' || !selected.distance)
    throw new Error(`Стойка ${id} с расстоянием не найдена.`)
  const { approach } = selected.distance
  const current = postMetres(selected.distance, scheme.parameters.signDistancesMetres)
  if (current === null)
    throw new Error('Сначала заполните расстояние этой стойки на этапе 2 или задайте своё.')
  const metres = Math.max(0, current + (approach === 'left' ? -screenStepMetres : screenStepMetres))
  if (metres === current) return scheme
  const edited = markRoadCalculationEdited(scheme.roadLayout, id)
  const result = schemeSchema.safeParse({
    ...scheme,
    roadLayout: edited.automation
      ? {
          ...edited,
          automation: {
            ...edited.automation,
            layoutPositions: edited.automation.layoutPositions?.filter(
              (item) => item.placementId !== id,
            ),
          },
        }
      : edited,
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
