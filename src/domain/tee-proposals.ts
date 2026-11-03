import { schemeSchema, type Scheme, type SignPlacement } from './model'
import type { RoadObjectLink } from './road-layout'
import { removePlacement, restoreRoadPlacement } from './edit-placements'
import { roadCalculationBasis, roadValuesEqual } from './road-calculation-state'

export class TeeProposalError extends Error {}
type Pair = { post: SignPlacement; link: RoadObjectLink; excluded: boolean }
function pairs(scheme: Scheme): Pair[] {
  return [
    ...scheme.roadLayout.links.flatMap((link) => {
      const post = scheme.placements.find((p) => p.id === link.placementId)
      return post?.kind === 'sign-post' ? [{ post, link, excluded: false }] : []
    }),
    ...(scheme.roadObjectExclusions?.objects ?? []).map((item) => ({ ...item, excluded: true })),
  ]
}
/** Selection is explicit: never infer "beyond the tee" or normative ownership from pixels. */
export function teeSourcePosts(scheme: Scheme): Pair[] {
  const all = pairs(scheme),
    referenced = new Set(
      all.flatMap((p) =>
        p.link.calculation?.ruleId === 'project-tee-transfer-v1'
          ? [p.link.calculation.sourcePlacementId]
          : [],
      ),
    )
  return all
    .filter(
      (p) =>
        !p.link.calculation &&
        p.link.role === 'tee-branch' &&
        (!p.link.branchPlacement || referenced.has(p.post.id)) &&
        scheme.roadLayout.nodes.some(
          (node) => node.id === p.link.nodeId && node.kind === 'terminal-tee',
        ),
    )
    .sort((a, b) => a.post.id - b.post.id)
}
export type TeeProposalItem = {
  key: string
  sourceId: number
  sourceActive: boolean
  branch: 'up' | 'down'
  kind: 'create' | 'update' | 'unchanged' | 'modified' | 'excluded'
  post: SignPlacement
  link: RoadObjectLink
  current?: Pair
}
export type TeeProposalPlan = { basis: string; sourceIds: number[]; items: TeeProposalItem[] }
export type TeeProposalChoices = Record<string, 'keep' | 'accept' | 'restore'>
function planBasis(scheme: Scheme, sourceIds: number[]) {
  return JSON.stringify({ scheme, sourceIds })
}

export function prepareTeeProposals(scheme: Scheme, input: number[]): TeeProposalPlan {
  const sources = teeSourcePosts(scheme),
    sourceIds = [...input].sort((a, b) => a - b),
    all = pairs(scheme)
  if (
    !sourceIds.length ||
    new Set(sourceIds).size !== sourceIds.length ||
    sourceIds.some((id) => !sources.some((p) => p.post.id === id))
  )
    throw new TeeProposalError('Выберите существующие исходные стойки Т-перекрёстка.')
  let nextId = scheme.nextPlacementId
  const items: TeeProposalItem[] = []
  for (const sourceId of sourceIds) {
    const source = sources.find((p) => p.post.id === sourceId)!,
      node = scheme.roadLayout.nodes.find((n) => n.id === source.link.nodeId)!
    const index = sources
      .filter((p) => p.link.nodeId === node.id)
      .findIndex((p) => p.post.id === sourceId)
    // Conditional drawing defaults, not installation metres or new normative parameters.
    const alongSvg = 140 + index * 90,
      acrossSvg = node.position.approach === 'left' ? -150 : 150
    const rotation = node.position.approach === 'left' ? 270 : 90
    const basis = roadCalculationBasis({
      rule: 'project-tee-transfer-v1',
      post: source.post,
      link: source.link,
      node: { id: node.id, position: node.position, sheetOffsetXSvg: node.sheetOffsetXSvg },
      alongSvg,
      acrossSvg,
      rotation,
    })
    for (const branch of ['up', 'down'] as const) {
      const current = all.find(
        (p) =>
          p.link.nodeId === node.id &&
          p.link.calculation?.sourcePlacementId === sourceId &&
          p.link.calculation.branch === branch,
      )
      const id = current?.post.id ?? nextId++
      const { templateSlot: _slot, ...sourcePost } = source.post
      void _slot
      const post: SignPlacement = {
        ...sourcePost,
        id,
        generatedByTemplate: false,
        side: 'up',
        stand: 'left',
        signIds: [...source.post.signIds],
      }
      const link: RoadObjectLink = {
        placementId: id,
        nodeId: node.id,
        role: 'tee-branch',
        origin: 'manual',
        installation: null,
        branchPlacement: { branch, alongSvg, acrossSvg, rotation },
        calculation: {
          ruleId: 'project-tee-transfer-v1',
          sourcePlacementId: sourceId,
          branch,
          state: 'automatic',
          basis,
          sourceSignIds: [...source.post.signIds],
          nodePosition: { ...node.position },
        },
      }
      const kind = !current
        ? 'create'
        : current.excluded
          ? 'excluded'
          : current.link.calculation?.state === 'modified'
            ? 'modified'
            : roadValuesEqual({ post: current.post, link: current.link }, { post, link })
              ? 'unchanged'
              : 'update'
      items.push({
        key: `${node.id}:${sourceId}:${branch}`,
        sourceId,
        sourceActive: !source.excluded,
        branch,
        kind,
        post,
        link,
        ...(current ? { current } : {}),
      })
    }
  }
  // The UI may wrap the input in Vue proxies; copy JSON data without retaining mutable aliases.
  return {
    basis: planBasis(scheme, sourceIds),
    sourceIds,
    items: JSON.parse(JSON.stringify(items)) as TeeProposalItem[],
  }
}
function writeItem(item: TeeProposalItem, choices: TeeProposalChoices) {
  return (
    item.kind === 'create' ||
    item.kind === 'update' ||
    (item.kind === 'modified' && choices[item.key] === 'accept') ||
    (item.kind === 'excluded' && choices[item.key] === 'restore')
  )
}
export function teeProposalsHaveChanges(
  plan: TeeProposalPlan,
  choices: TeeProposalChoices,
): boolean {
  return plan.items.some(
    (item) =>
      writeItem(item, choices) ||
      (item.sourceActive && (item.kind !== 'excluded' || choices[item.key] === 'restore')),
  )
}
export function teeSourcesToExclude(plan: TeeProposalPlan, choices: TeeProposalChoices): number[] {
  return [
    ...new Set(
      plan.items
        .filter(
          (item) =>
            item.sourceActive && (item.kind !== 'excluded' || choices[item.key] === 'restore'),
        )
        .map((item) => item.sourceId),
    ),
  ]
}
/** Recompute from the document; never trust mutable preview rows as executable input. */
export function applyTeeProposals(
  scheme: Scheme,
  plan: TeeProposalPlan,
  choices: TeeProposalChoices = {},
): Scheme {
  if (plan.basis !== planBasis(scheme, plan.sourceIds))
    throw new TeeProposalError('Проект изменился. Подготовьте предложения заново.')
  const fresh = prepareTeeProposals(scheme, plan.sourceIds)
  for (const [key, value] of Object.entries(choices)) {
    const item = fresh.items.find((row) => row.key === key)
    if (
      !item ||
      !(
        value === 'keep' ||
        (item.kind === 'modified' && value === 'accept') ||
        (item.kind === 'excluded' && value === 'restore')
      )
    )
      throw new TeeProposalError('Выбор для предложения устарел. Подготовьте план заново.')
  }
  if (!teeProposalsHaveChanges(fresh, choices)) return scheme
  let next = scheme
  const sources = teeSourcesToExclude(fresh, choices)
  for (const id of sources) next = removePlacement(next, id)
  for (const item of fresh.items) {
    if (!writeItem(item, choices)) continue
    if (item.kind === 'excluded') next = restoreRoadPlacement(next, item.post.id)
    const present = next.placements.some((post) => post.id === item.post.id)
    next = {
      ...next,
      ...(!present && next.roadObjectExclusions
        ? {
            roadObjectExclusions: {
              ...next.roadObjectExclusions,
              placementOrder: [...next.roadObjectExclusions.placementOrder, item.post.id],
              linkOrder: [...next.roadObjectExclusions.linkOrder, item.post.id],
            },
          }
        : {}),
      placements: present
        ? next.placements.map((post) => (post.id === item.post.id ? item.post : post))
        : [...next.placements, item.post],
      roadLayout: {
        ...next.roadLayout,
        links: present
          ? next.roadLayout.links.map((link) =>
              link.placementId === item.post.id ? item.link : link,
            )
          : [...next.roadLayout.links, item.link],
      },
      nextPlacementId: Math.max(next.nextPlacementId, item.post.id + 1),
    }
  }
  const result = schemeSchema.safeParse(next)
  if (!result.success)
    throw new TeeProposalError(
      result.error.issues[0]?.message ?? 'Не удалось проверить предложения.',
    )
  return result.data
}
