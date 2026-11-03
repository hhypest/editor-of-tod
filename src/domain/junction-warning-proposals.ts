import { schemeSchema, type Scheme, type SignPlacement } from './model'
import type { RoadNode, RoadObjectLink } from './road-layout'
import { PROTOTYPE_RULES, type NormativeRules } from './normative-parameters'
import { roadCalculationBasis, roadValuesEqual } from './road-calculation-state'
import { restoreRoadPlacement } from './edit-placements'
import { distancePlate } from './sign-code'

export class JunctionWarningError extends Error {}
type Pair = { post: SignPlacement; link: RoadObjectLink; excluded: boolean }
function objects(scheme: Scheme): Pair[] {
  const posts = new Map(scheme.placements.map((post) => [post.id, post]))
  return [
    ...scheme.roadLayout.links.flatMap((link) => {
      const post = posts.get(link.placementId)
      return post?.kind === 'sign-post' ? [{ post, link, excluded: false }] : []
    }),
    ...(scheme.roadObjectExclusions?.objects ?? []).map((item) => ({ ...item, excluded: true })),
  ]
}
function rangeBasis(scheme: Scheme, rules: NormativeRules) {
  return rules.parameterBasis[
    scheme.parameters.location === 'in' ? 'project-junction-range-in' : 'project-junction-range-out'
  ]
}
/** Explicit project decisions D3/D9; never derive the plate value from drawing coordinates. */
export function junctionWarningCodes(node: Extract<RoadNode, { kind: 'junction' }>): string[] {
  const right = (node.position.approach === 'left') === (node.side === 'down')
  const code = `${right ? '8.1.3' : '8.1.4'}_${node.position.metres}`
  if (!distancePlate(code))
    throw new JunctionWarningError('Проверьте точность расстояния до узла для таблички.')
  return ['1.25', code]
}
/** A saved request is required; old manually associated objects are never silently adopted. */
export function junctionWarningReason(
  scheme: Scheme,
  node: RoadNode,
  rules: NormativeRules = PROTOTYPE_RULES,
): string | null {
  if (node.kind !== 'junction') return 'Для Т-перекрёстка используется отдельное предложение.'
  if (node.roadKind === 'yard') return 'Автоматика на выезде не применяется по решению Д5.'
  if (!node.sideWarningRequested)
    return 'Сначала сохраните запрос предупреждающего знака в свойствах узла.'
  if (scheme.parameters.location === 'auto')
    return 'Укажите расположение в населённом пункте или вне его.'
  const basis = rangeBasis(scheme, rules)
  if (!basis || typeof basis.value !== 'number' || !Number.isFinite(basis.value) || basis.value < 0)
    return 'Недоступна граница включения примыканий в нормативных параметрах.'
  if (node.position.metres > basis.value)
    return `Узел дальше границы включения ${basis.value} м (решение Д2).`
  if (
    scheme.roadLayout.nodes.some(
      (other) =>
        other.kind === 'terminal-tee' && other.position.approach === node.position.approach,
    )
  )
    return 'Примыкание на подходе с конечным Т-перекрёстком требует отдельного разбора.'
  if (
    objects(scheme).some(
      (item) =>
        item.link.nodeId === node.id && item.link.role === 'side-warning' && !item.link.calculation,
    )
  )
    return 'У узла уже сохранена ручная предупреждающая стойка. Проверьте её в свойствах; автоматическое присвоение происхождения не выполняется.'
  try {
    junctionWarningCodes(node)
  } catch (cause) {
    return (cause as Error).message
  }
  return null
}
export type JunctionWarningItem = {
  nodeId: number
  kind: 'create' | 'update' | 'unchanged' | 'modified' | 'excluded'
  post: SignPlacement
  link: RoadObjectLink
  current?: Pair
}
export type JunctionWarningPlan = { basis: string; nodeIds: number[]; items: JunctionWarningItem[] }
export type JunctionWarningChoices = Record<number, 'keep' | 'accept' | 'restore'>
function basis(scheme: Scheme, ids: number[], rules: NormativeRules) {
  return JSON.stringify({ scheme, ids, range: rangeBasis(scheme, rules) })
}
export function prepareJunctionWarnings(
  scheme: Scheme,
  input: number[],
  rules: NormativeRules = PROTOTYPE_RULES,
): JunctionWarningPlan {
  const ids = [...input].sort((a, b) => a - b),
    all = objects(scheme)
  if (!ids.length || new Set(ids).size !== ids.length)
    throw new JunctionWarningError('Выберите примыкания для просмотра.')
  let nextId = scheme.nextPlacementId
  const items: JunctionWarningItem[] = ids.map((nodeId) => {
    const node = scheme.roadLayout.nodes.find((node) => node.id === nodeId)
    if (!node) throw new JunctionWarningError('Примыкание не найдено.')
    const reason = junctionWarningReason(scheme, node, rules)
    if (reason) throw new JunctionWarningError(reason)
    if (node.kind !== 'junction') throw new JunctionWarningError('Выберите обычное примыкание.')
    const current = all.find(
      (item) =>
        item.link.nodeId === nodeId &&
        item.link.calculation?.ruleId === 'project-junction-warning-v1',
    )
    const signIds = junctionWarningCodes(node),
      id = current?.post.id ?? nextId++
    const post: SignPlacement = {
      id,
      kind: 'sign-post',
      generatedByTemplate: false,
      position: { anchor: node.position.from, offsetXSvg: 0, offsetYSvg: 0 },
      side: 'up',
      stand: 'left',
      signIds,
      distance: null,
      distanceLabel: null,
    }
    const branchPlacement = {
      branch: node.side,
      alongSvg: 140,
      acrossSvg: node.position.approach === 'left' ? -150 : 150,
      rotation: node.position.approach === 'left' ? (270 as const) : (90 as const),
    }
    const savedBasis = rangeBasis(scheme, rules)!
    const link: RoadObjectLink = {
      placementId: id,
      nodeId,
      role: 'side-warning',
      origin: 'manual',
      installation: null,
      branchPlacement,
      calculation: {
        ruleId: 'project-junction-warning-v1',
        sourcePlacementId: null,
        branch: node.side,
        state: 'automatic',
        basis: roadCalculationBasis({
          node,
          signIds,
          branchPlacement,
          range: savedBasis,
          location: scheme.parameters.location,
        }),
        nodePosition: { ...node.position },
        sourceSignIds: signIds,
        rangeBasis: savedBasis,
      },
    }
    const kind = !current
      ? 'create'
      : current.excluded
        ? 'excluded'
        : current.link.calculation?.state === 'modified'
          ? 'modified'
          : roadValuesEqual({ post, link }, { post: current.post, link: current.link })
            ? 'unchanged'
            : 'update'
    return { nodeId, kind, post, link, ...(current ? { current } : {}) }
  })
  return {
    basis: basis(scheme, ids, rules),
    nodeIds: ids,
    items: JSON.parse(JSON.stringify(items)) as JunctionWarningItem[],
  }
}
function writes(item: JunctionWarningItem, choices: JunctionWarningChoices) {
  return (
    item.kind === 'create' ||
    item.kind === 'update' ||
    (item.kind === 'modified' && choices[item.nodeId] === 'accept') ||
    (item.kind === 'excluded' && choices[item.nodeId] === 'restore')
  )
}
export function junctionWarningsHaveChanges(
  plan: JunctionWarningPlan,
  choices: JunctionWarningChoices,
): boolean {
  return plan.items.some((item) => writes(item, choices))
}
export function applyJunctionWarnings(
  scheme: Scheme,
  plan: JunctionWarningPlan,
  choices: JunctionWarningChoices = {},
  rules: NormativeRules = PROTOTYPE_RULES,
): Scheme {
  if (plan.basis !== basis(scheme, plan.nodeIds, rules))
    throw new JunctionWarningError(
      'Проект или параметры изменились. Подготовьте предложения заново.',
    )
  const fresh = prepareJunctionWarnings(scheme, plan.nodeIds, rules)
  for (const [key, choice] of Object.entries(choices)) {
    const item = fresh.items.find((item) => String(item.nodeId) === key)
    if (
      !item ||
      !(
        choice === 'keep' ||
        (choice === 'accept' && item.kind === 'modified') ||
        (choice === 'restore' && item.kind === 'excluded')
      )
    )
      throw new JunctionWarningError('Решение для предложения устарело.')
  }
  if (!junctionWarningsHaveChanges(fresh, choices)) return scheme
  let next = scheme
  for (const item of fresh.items) {
    if (!writes(item, choices)) continue
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
  const parsed = schemeSchema.safeParse(next)
  if (!parsed.success)
    throw new JunctionWarningError(
      parsed.error.issues[0]?.message ?? 'Не удалось проверить предложение.',
    )
  return parsed.data
}
