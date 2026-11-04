import { z } from 'zod'
import { parameterBasisSchema } from './decision-evidence-schema.ts'

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

/** Explicit conditional placement on a branch; these are drawing units, never metres. */
export const branchPlacementSchema = z.strictObject({
  branch: z.enum(['up', 'down']),
  alongSvg: finite.nonnegative().max(1_000_000),
  acrossSvg: finite.min(-1_000_000).max(1_000_000),
  scale: z.number().min(0.5).max(1).optional(),
  rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]),
})
export type BranchPlacement = z.infer<typeof branchPlacementSchema>

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
  branchPlacement: branchPlacementSchema.optional(),
  calculation: z
    .discriminatedUnion('ruleId', [
      z.strictObject({
        ruleId: z.literal('project-tee-transfer-v1'),
        sourcePlacementId: id,
        branch: z.enum(['up', 'down']),
        state: z.enum(['automatic', 'modified']),
        basis: z.string().regex(/^[0-9a-f]{16}$/),
        sourceSignIds: z.array(z.string().min(1).max(120)).min(1).max(20),
        nodePosition: roadNodePositionSchema,
      }),
      z.strictObject({
        ruleId: z.literal('project-road-layout-v1'),
        sourcePlacementId: id.nullable(),
        slot: z.string().min(1).max(160),
        branch: z.enum(['up', 'down']),
        state: z.enum(['automatic', 'modified']),
        basis: z.string().regex(/^[0-9a-f]{16}$/),
        sourceSignIds: z.array(z.string().min(1).max(120)).min(1).max(20),
        nodePosition: roadNodePositionSchema,
      }),
      z.strictObject({
        ruleId: z.literal('project-junction-warning-v1'),
        sourcePlacementId: z.null(),
        branch: z.enum(['up', 'down']),
        state: z.enum(['automatic', 'modified']),
        basis: z.string().regex(/^[0-9a-f]{16}$/),
        sourceSignIds: z.array(z.string().min(1).max(120)).min(1).max(20),
        nodePosition: roadNodePositionSchema,
        rangeBasis: parameterBasisSchema.refine(
          (basis) =>
            ['project-junction-range-in', 'project-junction-range-out'].includes(basis.id) &&
            typeof basis.value === 'number' &&
            Number.isFinite(basis.value) &&
            basis.value >= 0,
          'Неверное основание границы включения примыкания.',
        ),
      }),
    ])
    .optional(),
})

export const roadLayoutSchema = z
  .strictObject({
    automation: z
      .strictObject({
        basis: z.string().regex(/^[0-9a-f]{16}$/),
        profile: z.array(parameterBasisSchema).max(100),
        layoutPositions: z
          .array(
            z.strictObject({
              placementId: id,
              x: finite,
              y: finite,
              scale: z.number().min(0.5).max(1),
            }),
          )
          .max(2000)
          .optional(),
        nodeOffsets: z
          .array(z.strictObject({ nodeId: id, offset: finite }))
          .max(2000)
          .optional(),
        hiddenSourceIds: z.array(id).max(2000),
        baseIds: z.array(id).min(1).max(2000),
        outputs: z
          .array(z.strictObject({ nodeId: id, slot: z.string().max(160), placementId: id }))
          .max(2000),
      })
      .optional(),
    notes: z.strictObject({ text: z.string().max(5000), basis: z.string().max(128) }).optional(),
    detached: z
      .array(
        z.strictObject({
          placementId: id,
          nodeId: id,
          reason: z.string().max(5000),
          previousLink: roadObjectLinkSchema,
          x: finite,
          y: finite,
          rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]),
        }),
      )
      .max(2000)
      .optional(),
    nextNodeId: id,
    nodes: z.array(roadNodeSchema).max(2_000),
    links: z.array(roadObjectLinkSchema).max(2_000),
  })
  .superRefine((layout, context) => {
    const unique = (values: Array<string | number>, path: string[]) => {
      if (new Set(values).size !== values.length)
        context.addIssue({
          code: 'custom',
          path,
          message: 'Повторяющиеся идентификаторы в состоянии примыканий.',
        })
    }
    const receipt = layout.automation
    if (receipt) {
      unique(receipt.baseIds, ['automation', 'baseIds'])
      unique(receipt.hiddenSourceIds, ['automation', 'hiddenSourceIds'])
      unique(
        receipt.outputs.map((item) => `${item.nodeId}:${item.slot}`),
        ['automation', 'outputs'],
      )
      unique(
        receipt.outputs.map((item) => item.placementId),
        ['automation', 'outputs'],
      )
      unique(
        receipt.profile.map((item) => item.id),
        ['automation', 'profile'],
      )
      unique(
        (receipt.layoutPositions ?? []).map((item) => item.placementId),
        ['automation', 'layoutPositions'],
      )
      unique(
        (receipt.nodeOffsets ?? []).map((item) => item.nodeId),
        ['automation', 'nodeOffsets'],
      )
    }
    unique(
      (layout.detached ?? []).map((item) => item.placementId),
      ['detached'],
    )
    for (const [index, item] of (layout.detached ?? []).entries()) {
      if (
        item.placementId !== item.previousLink.placementId ||
        item.nodeId !== item.previousLink.nodeId ||
        layout.links.some((link) => link.placementId === item.placementId)
      )
        context.addIssue({
          code: 'custom',
          path: ['detached', index],
          message: 'Отсоединённый объект имеет противоречивую связь.',
        })
    }
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
      if (
        link.calculation &&
        link.calculation.ruleId !== 'project-road-layout-v1' &&
        ((link.calculation.ruleId === 'project-tee-transfer-v1'
          ? node?.kind !== 'terminal-tee' || link.role !== 'tee-branch'
          : node?.kind !== 'junction' || link.role !== 'side-warning') ||
          (link.calculation.state === 'automatic' &&
            link.branchPlacement?.branch !== link.calculation.branch))
      )
        context.addIssue({
          code: 'custom',
          path: ['links', index, 'calculation'],
          message: 'Расчётное происхождение не соответствует узлу, назначению или ветви.',
        })
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
      if (
        link.branchPlacement &&
        node &&
        (link.role === 'main-repeat' ||
          (node.kind === 'junction' && node.side !== link.branchPlacement.branch))
      )
        context.addIssue({
          code: 'custom',
          path: ['links', index, 'branchPlacement'],
          message:
            'Ветвь стойки не соответствует узлу или назначению связи. Сначала явно снимите размещение на ветви.',
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

/** Stable source identities span active posts and reversible exclusions. */
export function checkRoadCalculationSources(
  scheme: {
    placements: Array<{ id: number; kind: string }>
    roadLayout: RoadLayout
    roadObjectExclusions?: {
      objects: Array<{ post: { id: number; kind: string }; link: RoadObjectLink }>
    }
  },
  context: z.RefinementCtx,
) {
  const links = new Map(scheme.roadLayout.links.map((link) => [link.placementId, link]))
  const objects = new Map(
    scheme.placements.map((post) => [post.id, { post, link: links.get(post.id) }]),
  )
  for (const item of scheme.roadObjectExclusions?.objects ?? []) objects.set(item.post.id, item)
  const keys = new Set<string>()
  for (const [id, item] of objects) {
    if (scheme.roadLayout.detached?.some((entry) => entry.placementId === id)) continue
    const calc = item.link?.calculation
    if (!calc) continue
    if (calc.ruleId === 'project-road-layout-v1') {
      const key = item.link!.nodeId + ':' + calc.ruleId + ':' + calc.slot
      if (keys.has(key))
        context.addIssue({
          code: 'custom',
          path: ['roadLayout'],
          message: 'Повторяющееся происхождение расчёта примыканий.',
        })
      keys.add(key)
      if (
        calc.sourcePlacementId !== null &&
        (!objects.has(calc.sourcePlacementId) || calc.sourcePlacementId === id)
      )
        context.addIssue({
          code: 'custom',
          path: ['roadLayout'],
          message: 'Потеряна исходная стойка переноса.',
        })
      continue
    }
    if (calc.ruleId === 'project-junction-warning-v1') {
      const key = item.link!.nodeId + ':' + calc.ruleId
      if (keys.has(key))
        context.addIssue({
          code: 'custom',
          path: ['roadLayout'],
          message: 'Повторяющееся расчётное предупреждение для примыкания.',
        })
      keys.add(key)
      continue
    }
    const source = objects.get(calc.sourcePlacementId),
      key = `${item.link!.nodeId}:${calc.sourcePlacementId}:${calc.branch}`
    if (
      item.post.kind !== 'sign-post' ||
      id === calc.sourcePlacementId ||
      !source?.link ||
      source.post.kind !== 'sign-post' ||
      source.link.nodeId !== item.link!.nodeId ||
      source.link.calculation ||
      keys.has(key)
    )
      context.addIssue({
        code: 'custom',
        path: ['roadLayout'],
        message:
          'Расчётная стойка имеет повторяющееся происхождение или потеряла исходную стойку и её связь.',
      })
    keys.add(key)
  }
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
    else if (link.branchPlacement && placement.kind !== 'sign-post')
      context.addIssue({
        code: 'custom',
        path: ['roadLayout', 'links', index, 'branchPlacement'],
        message: 'На ветви размещается только стойка.',
      })
  }
}
