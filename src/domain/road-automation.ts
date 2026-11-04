import { legacyRoadLayoutProblem } from './legacy-road-layout'
import { packRoadAutomation } from './road-automation-layout'
import { schemeSchema, type Scheme, type SignPlacement } from './model'
import type { RoadNode, RoadObjectLink } from './road-layout'
import { buildBaseTemplatePlacements } from './template-placements'
import { PROTOTYPE_RULES, type NormativeRules } from './normative-parameters'
import { roadValuesEqual, roadCalculationBasis } from './road-calculation-state'
import { roadAutomationBasis } from './road-automation-state'
import { postMetres } from './post-distance'
import { junctionWarningCodes } from './junction-warning-proposals'

type Saved = { detached?: boolean; post: SignPlacement; link: RoadObjectLink; excluded: boolean }
export type RoadPlanRow = {
  key: string
  nodeId: number
  id: number
  kind: 'create' | 'update' | 'unchanged' | 'modified' | 'excluded' | 'manual'
  signIds: string[]
  post: SignPlacement
  current?: Saved
  link: RoadObjectLink
}
export type RoadPlan = {
  basis: string
  rows: RoadPlanRow[]
  hiddenIds: number[]
  warnings: string[]
  baseCount: number
}
export type RoadChoices = Record<string, 'keep' | 'accept' | 'restore'>
export class RoadAutomationError extends Error {}

function profile(rules: NormativeRules) {
  const basis = rules.parameterBasis['project-road-profile'],
    table = basis?.value
  if (!table || typeof table !== 'object')
    throw new RoadAutomationError('Недоступен профиль автоматики примыканий.')
  const n = (key: string) => {
    const value = Number(table[key])
    if (!table[key] || !Number.isFinite(value) || value <= 0)
      throw new RoadAutomationError(`Профиль примыканий: проверьте «${key}».`)
    return value
  }
  const result = {
    installation: n('Установка предупреждения от L0/E'),
    threshold: n('Граница большого отступа'),
    offset: n('Большой отступ повтора'),
    small: n('Малый отступ повтора'),
    round: n('Шаг округления таблички'),
    minimum: n('Минимум для повторного 1.25'),
    maxOut: n('Максимум для повторного 1.25 вне н.п.'),
    maxIn: n('Максимум для повторного 1.25 в н.п.'),
    teeOffset: n('Отступ предупреждения tee'),
    endMin: n('Минимум для переноса конца ограничений'),
  }
  if (result.small >= result.minimum || result.offset >= result.threshold)
    throw new RoadAutomationError(
      'Отступ повтора должен быть меньше соответствующей границы профиля.',
    )
  return result
}
function allObjects(s: Scheme): Saved[] {
  const posts = new Map(s.placements.map((p) => [p.id, p]))
  return [
    ...s.roadLayout.links.flatMap((link) => {
      const post = posts.get(link.placementId)
      return post?.kind === 'sign-post' ? [{ post, link, excluded: false }] : []
    }),
    ...(s.roadObjectExclusions?.objects ?? []).map((item) => ({ ...item, excluded: true })),
    ...(s.roadLayout.detached ?? []).flatMap((item) => {
      const post = posts.get(item.placementId)
      return post?.kind === 'sign-post' &&
        !s.roadLayout.links.some((link) => link.placementId === post.id)
        ? [{ post, link: item.previousLink, excluded: false, detached: true }]
        : []
    }),
  ]
}
function inputs(s: Scheme, r: NormativeRules) {
  return JSON.stringify([s, r.parameterBasis])
}
function derive(s: Scheme, rules: NormativeRules, choices: RoadChoices) {
  if (
    legacyRoadLayoutProblem(s.source) &&
    !s.roadLayout.nodes.length &&
    !s.roadLayout.detached?.length &&
    !s.roadLayout.automation
  )
    throw new RoadAutomationError(
      'В старом исходнике есть неподдержанные узлы. Сначала восстановите их модель; исходник сохранён.',
    )
  const p = profile(rules),
    all = allObjects(s),
    oldReceipt = s.roadLayout.automation,
    warnings: string[] = [],
    rows: RoadPlanRow[] = [],
    hiddenIds: number[] = [],
    outputs: Array<{ nodeId: number; slot: string; placementId: number }> = []
  let nextId = s.nextPlacementId
  const posts = new Map(s.placements.map((post) => [post.id, post])),
    links = new Map(s.roadLayout.links.map((link) => [link.placementId, link])),
    excluded = new Map((s.roadObjectExclusions?.objects ?? []).map((item) => [item.post.id, item]))
  const allPosts = [...s.placements, ...excluded.values()].map((item) =>
    'post' in item ? item.post : item,
  )
  const existingSlots = new Map(
    allPosts.filter((post) => post.templateSlot).map((post) => [post.templateSlot!, post]),
  )
  const fresh = buildBaseTemplatePlacements(s, rules).map((post) => {
    const old = post.templateSlot ? existingSlots.get(post.templateSlot) : undefined
    return old
      ? old.generatedByTemplate
        ? { ...post, id: old.id }
        : old
      : { ...post, id: nextId++ }
  })
  const freshSlots = new Set(fresh.flatMap((post) => post.templateSlot ?? []))
  // Replace only generated template objects; preserve every unowned/manual object.
  for (const post of s.placements)
    if (
      post.generatedByTemplate &&
      post.templateSlot &&
      !freshSlots.has(post.templateSlot) &&
      !links.has(post.id)
    )
      posts.delete(post.id)
  for (const post of fresh) {
    const wasHidden =
      oldReceipt?.hiddenSourceIds.includes(post.id) ||
      all.some((item) => item.link.calculation?.sourcePlacementId === post.id)
    if (excluded.has(post.id) && !wasHidden) continue
    const saved = excluded.get(post.id)
    if (
      saved &&
      s.roadLayout.nodes.some((n) => n.id === saved.link.nodeId) &&
      all.some((item) => item.link.calculation?.sourcePlacementId === post.id)
    )
      links.set(post.id, saved.link)
    excluded.delete(post.id)
    posts.set(post.id, post)
  }
  const hide = (post: SignPlacement, node: RoadNode) => {
    const link = links.get(post.id) ??
      excluded.get(post.id)?.link ?? {
        placementId: post.id,
        nodeId: node.id,
        role: node.kind === 'terminal-tee' ? ('tee-branch' as const) : ('main-repeat' as const),
        origin: 'manual' as const,
        installation: null,
      }
    posts.delete(post.id)
    links.delete(post.id)
    excluded.set(post.id, { post, link })
    hiddenIds.push(post.id)
  }
  const used = new Set<number>()
  const propose = (
    node: RoadNode,
    slot: string,
    signIds: string[],
    metres: number | null,
    branch?: 'up' | 'down',
    source?: SignPlacement,
  ) => {
    const current =
      all.find(
        (item) =>
          item.link.nodeId === node.id &&
          item.link.calculation?.ruleId === 'project-road-layout-v1' &&
          item.link.calculation.slot === slot,
      ) ??
      all.find(
        (item) =>
          !used.has(item.post.id) &&
          item.link.nodeId === node.id &&
          ((slot === 'side' && item.link.role === 'side-warning') ||
            (source &&
              branch &&
              item.link.calculation?.ruleId === 'project-tee-transfer-v1' &&
              item.link.calculation.sourcePlacementId === source.id &&
              item.link.calculation.branch === branch)),
      )
    if (current) used.add(current.post.id)
    const reserved = oldReceipt?.outputs.find(
      (output) => output.nodeId === node.id && output.slot === slot,
    )?.placementId
    const id =
        current?.post.id ??
        (reserved && !posts.has(reserved) && !excluded.has(reserved) ? reserved : undefined) ??
        nextId++,
      approach = node.position.approach,
      from = node.position.from
    const post: SignPlacement = {
      ...source,
      kind: 'sign-post',
      id,
      generatedByTemplate: false,
      position: { anchor: from, offsetXSvg: 0, offsetYSvg: 0 },
      side: branch
        ? 'up'
        : slot === 'end' && source
          ? source.side
          : approach === 'left'
            ? 'down'
            : 'up',
      stand: branch
        ? 'left'
        : slot === 'end' && source
          ? source.stand
          : slot === 'main-warning'
            ? 'left'
            : approach === 'left'
              ? 'left'
              : 'right',
      signIds: [...signIds],
      distance: branch ? null : metres === null ? null : { by: 'metres', approach, metres },
      distanceLabel: null,
    }
    delete post.templateSlot
    const ordinal = source
      ? 1 +
        Math.max(
          0,
          fresh
            .filter((post) => post.kind === 'sign-post' && post.distance?.approach === approach)
            .findIndex((post) => post.id === source.id),
        )
      : 0
    const link: RoadObjectLink = {
      placementId: id,
      nodeId: node.id,
      role: node.kind === 'terminal-tee' ? 'tee-branch' : branch ? 'side-warning' : 'main-repeat',
      origin: 'manual',
      installation:
        metres === null ? null : { from: source && branch ? 'node-axis' : from, metres },
      ...(branch
        ? {
            branchPlacement: {
              branch,
              alongSvg: 110 + (ordinal % 2) * 75,
              acrossSvg:
                (Math.floor(ordinal / 2) % 2 ? -1 : 1) * (approach === 'left' ? -150 : 150),
              rotation: approach === 'left' ? (270 as const) : (90 as const),
            },
          }
        : {}),
      calculation: {
        ruleId: 'project-road-layout-v1',
        slot,
        sourcePlacementId: source?.id ?? null,
        branch: branch ?? (approach === 'left' ? 'down' : 'up'),
        state: 'automatic',
        basis: roadCalculationBasis([
          node.id,
          node.position,
          node.kind === 'junction'
            ? [node.side, node.roadKind, node.sideWarningRequested]
            : node.branchNames,
          slot,
          signIds,
          metres,
          source ?? null,
          rules.parameterBasis,
        ]),
        nodePosition: { ...node.position },
        sourceSignIds: [...signIds],
      },
    }
    const kind: RoadPlanRow['kind'] = !current
      ? 'create'
      : current.excluded
        ? 'excluded'
        : current.link.calculation?.state === 'modified'
          ? 'modified'
          : !current.link.calculation
            ? 'manual'
            : roadValuesEqual({ post, link }, { post: current.post, link: current.link })
              ? 'unchanged'
              : 'update'
    const key = `${node.id}:${slot}`
    rows.push({
      key,
      nodeId: node.id,
      id,
      kind,
      signIds,
      post,
      link,
      ...(current ? { current } : {}),
    })
    const choice = choices[key]
    if (
      !current ||
      kind === 'update' ||
      kind === 'unchanged' ||
      choice === 'accept' ||
      choice === 'restore'
    ) {
      excluded.delete(id)
      posts.set(id, post)
      links.set(id, link)
    } else if (current.excluded) {
      posts.delete(id)
      links.delete(id)
      excluded.set(id, { post: current.post, link: current.link })
    } else {
      posts.set(id, current.post)
      if (!current.detached) links.set(id, current.link)
    }
    outputs.push({ nodeId: node.id, slot, placementId: id })
  }
  const yellow = (code: string) => (s.parameters.yellowTemporarySigns ? code + '_ж' : code)
  const speed = (value: number) => yellow(value === 50 ? '3.24' : `3.24_${value}`)
  const roundDown = (value: number) => Math.max(p.round, Math.floor(value / p.round) * p.round)
  const limitBasis =
    rules.parameterBasis[
      s.parameters.location === 'in' ? 'project-junction-range-in' : 'project-junction-range-out'
    ]
  if (typeof limitBasis?.value !== 'number')
    throw new RoadAutomationError('Недоступна граница включения узлов.')
  const limit = limitBasis.value
  const tee = s.roadLayout.nodes.find(
    (node) => node.kind === 'terminal-tee' && node.position.metres <= limit,
  )
  const previousSpeed = (node: RoadNode) =>
    fresh
      .flatMap((post) => {
        if (post.kind !== 'sign-post' || post.distance?.approach !== node.position.approach)
          return []
        const d = postMetres(post.distance, s.parameters.signDistancesMetres)
        if (d === null || d < node.position.metres) return []
        return post.signIds.flatMap((code) => {
          const m = /^3\.24(?:_(\d+))?(?:_ж)?$/.exec(code)
          return m ? [{ d, value: Number(m[1] ?? 50) }] : []
        })
      })
      .sort((a, b) => a.d - b.d)[0]?.value
  for (const node of s.roadLayout.nodes) {
    const d = node.position.metres
    if (d > limitBasis.value) {
      warnings.push(`Узел № ${node.id}: вне границы включения; автоматика не применяется.`)
      continue
    }
    if (node.kind === 'junction') {
      if (tee?.position.approach === node.position.approach) {
        warnings.push(`Узел № ${node.id}: примыкание на подходе с tee требует ручной сверки.`)
        continue
      }
      if (node.roadKind === 'yard') {
        warnings.push(`Узел № ${node.id}: выезд, автоматические повторы не применяются.`)
        continue
      }
      if (node.sideWarningRequested)
        propose(node, 'side', junctionWarningCodes(node), p.installation, node.side)
      const distance = d - (d >= p.threshold ? p.offset : p.small),
        codes: string[] = []
      if (distance < 0) {
        warnings.push(`Узел № ${node.id}: места для повторной стойки недостаточно.`)
        continue
      }
      if (d >= p.minimum && d <= (s.parameters.location === 'in' ? p.maxIn : p.maxOut))
        codes.push('1.25', `8.1.1_${roundDown(distance)}`)
      const prior = previousSpeed(node)
      codes.push(yellow('3.20'))
      if (prior !== undefined) codes.push(speed(prior))
      else
        warnings.push(
          `Узел № ${node.id}: предшествующая ступень 3.24 не найдена; скорость не назначена.`,
        )
      const collision = fresh.find(
        (post) =>
          post.kind === 'sign-post' &&
          post.distance?.approach === node.position.approach &&
          postMetres(post.distance, s.parameters.signDistancesMetres) === distance,
      )
      if (collision?.kind === 'sign-post') {
        hide(collision, node)
        propose(
          node,
          'repeat',
          [
            ...new Set([
              ...codes.filter(
                (code) =>
                  !collision.signIds.some((value) => value.startsWith('3.24')) ||
                  !code.startsWith('3.24'),
              ),
              ...collision.signIds,
            ]),
          ],
          distance,
          undefined,
          collision,
        )
      } else propose(node, 'repeat', codes, distance)
    } else {
      for (const post of fresh) {
        if (post.kind !== 'sign-post') continue
        const slot = post.templateSlot ?? '',
          same = slot.startsWith(`post2:${node.position.approach === 'left' ? 'L' : 'R'}:`)
        const metres = post.distance
          ? postMetres(post.distance, s.parameters.signDistancesMetres)
          : null
        if (same && metres !== null && metres > d) {
          if (
            !post.generatedByTemplate &&
            !s.roadObjectExclusions?.objects.some((item) => item.post.id === post.id)
          ) {
            warnings.push(
              `Стойка № ${post.id}: ручной исходник за tee сохранён; перенос проверьте отдельно.`,
            )
            continue
          }
          hide(post, node)
          propose(node, `up:${slot}`, post.signIds, metres - d, 'up', post)
          propose(node, `down:${slot}`, post.signIds, metres - d, 'down', post)
        }
        if (same && slot.endsWith(':end')) {
          hide(post, node)
          if (d >= p.endMin) propose(node, 'end', post.signIds, Math.round(d / 2), undefined, post)
        }
      }
      propose(
        node,
        'side-up',
        ['1.25', `${node.position.approach === 'left' ? '8.1.4' : '8.1.3'}_${d}`],
        p.installation,
        'up',
      )
      propose(
        node,
        'side-down',
        ['1.25', `${node.position.approach === 'left' ? '8.1.3' : '8.1.4'}_${d}`],
        p.installation,
        'down',
      )
      if (d >= p.minimum)
        propose(node, 'main-warning', ['1.25', `8.1.1_${d - p.teeOffset}`], d - p.teeOffset)
      else
        warnings.push(
          `Узел № ${node.id}: tee близко к работам; повторный 1.25 перед поворотом не создаётся.`,
        )
      const zoneDistance =
        s.parameters.signDistancesMetres[s.parameters.location === 'in' ? 'n50' : 'd50']
      if (zoneDistance === null)
        throw new RoadAutomationError('Заполните расстояние ближней ступени скорости.')
      const metres = Math.min(Math.round(d / 2), zoneDistance),
        codes = [
          speed(s.parameters.speedStagesKmh[2]),
          yellow('3.20'),
          yellow(node.position.approach === 'left' ? '1.20.2' : '1.20.3'),
        ]
      if (s.template.code === 'b34' && s.parameters.regulation.mode === 'signs')
        codes.push(yellow('2.6'), `8.1.1_${metres}`)
      propose(node, 'main-restrict', codes, metres)
    }
  }
  // Preserve obsolete calculations reversibly; never leave a stale automatic result active.
  const desired = new Set(outputs.map((item) => item.placementId))
  for (const item of all)
    if (item.link.calculation && !desired.has(item.post.id) && !hiddenIds.includes(item.post.id)) {
      if (item.link.calculation.state === 'automatic') {
        posts.delete(item.post.id)
        links.delete(item.post.id)
        excluded.set(item.post.id, { post: item.post, link: item.link })
        warnings.push(
          `Стойка № ${item.post.id}: прежнее расчётное предложение сохранено в исключённых.`,
        )
      } else
        warnings.push(
          `Стойка № ${item.post.id}: прежняя ручная правка сохранена; проверьте применимость.`,
        )
    }
  const order = [
    ...new Set([
      ...(s.roadObjectExclusions?.placementOrder ?? s.placements.map((p) => p.id)),
      ...posts.keys(),
      ...excluded.keys(),
    ]),
  ]
  const linkOrder = [
    ...new Set([
      ...(s.roadObjectExclusions?.linkOrder ?? s.roadLayout.links.map((l) => l.placementId)),
      ...links.keys(),
      ...[...excluded.values()].map((x) => x.post.id),
    ]),
  ]
  const parameterBasis = Object.values(rules.parameterBasis)
  let next: Scheme = {
    ...s,
    placements: order.flatMap((id) => posts.get(id) ?? []),
    nextPlacementId: nextId,
    roadLayout: {
      ...s.roadLayout,
      links: linkOrder.flatMap((id) => links.get(id) ?? []),
      detached: s.roadLayout.detached?.filter(
        (item) =>
          !links.has(item.placementId) &&
          !fresh.some(
            (post) =>
              post.id === item.placementId && post.generatedByTemplate && posts.has(post.id),
          ),
      ),
      automation: {
        basis: '0000000000000000',
        nodeOffsets: s.roadLayout.automation?.nodeOffsets,
        layoutPositions: s.roadLayout.automation?.layoutPositions?.filter(
          (p) =>
            (posts.get(p.placementId)?.generatedByTemplate === false &&
              !links.get(p.placementId)?.calculation) ||
            links.get(p.placementId)?.calculation?.state === 'modified',
        ),
        profile: parameterBasis,
        hiddenSourceIds: hiddenIds,
        baseIds: fresh.map((post) => post.id),
        outputs,
      },
    },
    ...(excluded.size
      ? {
          roadObjectExclusions: {
            objects: [...excluded.values()],
            placementOrder: order,
            linkOrder,
          },
        }
      : {}),
  }
  if (!excluded.size) delete next.roadObjectExclusions
  next.roadLayout.automation!.basis = roadAutomationBasis(next, parameterBasis)
  next = packRoadAutomation(next)
  for (const row of rows) {
    const link = next.roadLayout.links.find((l) => l.placementId === row.id)
    if (link) row.link = link
    if (
      row.current?.link.calculation?.state === 'automatic' &&
      !row.current.excluded &&
      roadValuesEqual(
        { post: row.post, link: row.link },
        { post: row.current.post, link: row.current.link },
      )
    )
      row.kind = 'unchanged'
  }
  return { next, rows, hiddenIds, warnings, baseCount: fresh.length }
}
export function prepareRoadAutomation(
  s: Scheme,
  rules: NormativeRules = PROTOTYPE_RULES,
): RoadPlan {
  const { rows, hiddenIds, warnings, baseCount } = derive(s, rules, {})
  return {
    basis: inputs(s, rules),
    rows: JSON.parse(JSON.stringify(rows)) as RoadPlanRow[],
    hiddenIds,
    warnings,
    baseCount,
  }
}
export function applyRoadAutomation(
  s: Scheme,
  plan: RoadPlan,
  choices: RoadChoices = {},
  rules: NormativeRules = PROTOTYPE_RULES,
): Scheme {
  if (plan.basis !== inputs(s, rules))
    throw new RoadAutomationError('Проект или параметры изменились. Подготовьте план заново.')
  const fresh = derive(s, rules, choices)
  for (const [key, value] of Object.entries(choices)) {
    const row = fresh.rows.find((row) => row.key === key)
    if (
      !row ||
      !(
        value === 'keep' ||
        (value === 'restore' && row.kind === 'excluded') ||
        (value === 'accept' && ['modified', 'manual'].includes(row.kind))
      )
    )
      throw new RoadAutomationError('Решение для строки плана устарело.')
  }
  return schemeSchema.parse(JSON.parse(JSON.stringify(fresh.next)))
}
