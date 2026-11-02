/* Frozen v12 road layout; no live domain imports. */
import { z } from 'zod'

const id = z.number().int().positive()
const finite = z.number().finite()
const text = z.string().max(5_000)

/** D2: distance to the node axis, from L0 on the left approach or E on the right. */
export const roadNodePositionSchema = z.discriminatedUnion('approach', [
  z.strictObject({
    approach: z.literal('left'),
    from: z.literal('L0'),
    metres: finite.nonnegative(),
  }),
  z.strictObject({
    approach: z.literal('right'),
    from: z.literal('E'),
    metres: finite.nonnegative(),
  }),
])

const nodeFields = {
  id,
  origin: z.enum(['manual', 'legacy-v1']),
  position: roadNodePositionSchema,
  /** Conditional sheet offset from the same L0/E; never a physical distance. */
  sheetOffsetXSvg: finite.nullable(),
}

export const roadNodeSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    ...nodeFields,
    kind: z.literal('junction'),
    side: z.enum(['up', 'down']),
    roadKind: z.enum(['road', 'yard']),
    name: text,
    sideWarningRequested: z.boolean(),
  }),
  z.strictObject({
    ...nodeFields,
    kind: z.literal('terminal-tee'),
    branchNames: z.strictObject({ up: text, down: text }),
  }),
])

export const roadObjectLinkSchema = z.strictObject({
  placementId: id,
  nodeId: id,
  role: z.enum(['main-repeat', 'side-warning', 'tee-branch']),
  /** A legacy association is not automatic ownership or proof of an unchanged object (RP7). */
  origin: z.enum(['manual', 'legacy-v1']),
  /** Place of the post, independently of the node distance and the plate's sign code/value. */
  installation: z
    .strictObject({
      from: z.enum(['L0', 'E', 'node-axis']),
      metres: finite.nonnegative(),
    })
    .nullable(),
})

export const roadLayoutSchema = z
  .strictObject({
    nextNodeId: id,
    nodes: z.array(roadNodeSchema).max(2_000),
    links: z.array(roadObjectLinkSchema).max(2_000),
  })
  .superRefine((layout, context) => {
    const nodes = new Map<number, RoadNode>()
    let tee = false
    for (const [index, node] of layout.nodes.entries()) {
      if (nodes.has(node.id))
        context.addIssue({
          code: 'custom',
          path: ['nodes', index, 'id'],
          message: 'Повторяющийся идентификатор примыкания',
        })
      nodes.set(node.id, node)
      if (node.kind === 'terminal-tee') {
        if (tee)
          context.addIssue({
            code: 'custom',
            path: ['nodes', index, 'kind'],
            message: 'Допускается один конечный Т-перекрёсток',
          })
        tee = true
      }
    }
    if (layout.nodes.some((node) => node.id >= layout.nextNodeId))
      context.addIssue({
        code: 'custom',
        path: ['nextNodeId'],
        message: 'Номер следующего примыкания уже занят',
      })
    const placements = new Set<number>()
    for (const [index, link] of layout.links.entries()) {
      const node = nodes.get(link.nodeId)
      if (!node)
        context.addIssue({
          code: 'custom',
          path: ['links', index, 'nodeId'],
          message: 'Примыкание для связанного объекта не найдено',
        })
      else if ((node.kind === 'terminal-tee') !== (link.role === 'tee-branch'))
        context.addIssue({
          code: 'custom',
          path: ['links', index, 'role'],
          message: 'Назначение связи не соответствует виду примыкания',
        })
      if (placements.has(link.placementId))
        context.addIssue({
          code: 'custom',
          path: ['links', index, 'placementId'],
          message: 'У объекта уже есть связь с примыканием',
        })
      placements.add(link.placementId)
    }
  })

export type RoadNode = z.infer<typeof roadNodeSchema>
export type RoadObjectLink = z.infer<typeof roadObjectLinkSchema>
export type RoadLayout = z.infer<typeof roadLayoutSchema>

export function emptyRoadLayout(): RoadLayout {
  return { nextNodeId: 1, nodes: [], links: [] }
}

/** Cross-aggregate references are validated at the project boundary. */
export function checkRoadLayoutPlacements(
  scheme: { roadLayout: RoadLayout; placements: readonly { id: number; kind: string }[] },
  context: z.RefinementCtx,
): void {
  const placements = new Map(scheme.placements.map((item) => [item.id, item]))
  for (const [index, link] of scheme.roadLayout.links.entries()) {
    const placement = placements.get(link.placementId)
    if (!placement)
      context.addIssue({
        code: 'custom',
        path: ['roadLayout', 'links', index, 'placementId'],
        message: 'Связанный объект схемы не найден',
      })
    else if (link.installation && placement.kind !== 'sign-post')
      context.addIssue({
        code: 'custom',
        path: ['roadLayout', 'links', index, 'installation'],
        message: 'Расстояние установки задаётся только для стойки',
      })
  }
}
