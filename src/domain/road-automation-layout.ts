import type { Scheme } from './model'
import { schemeLayout } from './placement-workspace'
import { projectDraftSheet } from './draft-sheet'
import { drawSheet } from './sheet-drawing'
import { roadAutomationBasis } from './road-automation-state'
import { postMetres } from './post-distance'
type Box = [number, number, number, number]
function overlaps(a: Box, b: Box) {
  return (
    a[0] < b[0] + b[2] + 8 &&
    b[0] < a[0] + a[2] + 8 &&
    a[1] < b[1] + b[3] + 8 &&
    b[1] < a[1] + a[3] + 8
  )
}
/** Conditional packing only: physical distances, codes, manual geometry and sources remain untouched. */
export function packRoadAutomation(s: Scheme): Scheme {
  const oldOffsets = s.roadLayout.automation!.nodeOffsets ?? []
  const oldPositions = s.roadLayout.automation!.layoutPositions ?? []
  const anchors = schemeLayout(s).anchors
  const initialLayout = schemeLayout(s)
  const initial = drawSheet(projectDraftSheet(s), {
    signSizes: new Map(),
    catalogLabel: '',
    revisionLabel: '',
  })
  const positions = [...oldPositions]
  const offsets = [...oldOffsets]
  for (const approach of ['left', 'right'] as const) {
    const nodes = s.roadLayout.nodes.filter((n) => n.position.approach === approach)
    if (
      !nodes.length ||
      nodes.some(
        (n) =>
          n.sheetOffsetXSvg !== null &&
          !oldOffsets.some((o) => o.nodeId === n.id && o.offset === n.sheetOffsetXSvg),
      )
    )
      continue
    const incoming = s.placements.filter(
      (p) =>
        p.kind === 'sign-post' &&
        p.distance?.approach === approach &&
        p.side === (approach === 'left' ? 'down' : 'up') &&
        !s.roadLayout.links.some((l) => l.placementId === p.id && l.branchPlacement) &&
        (p.generatedByTemplate ||
          s.roadLayout.links.some(
            (l) =>
              l.placementId === p.id &&
              l.calculation?.ruleId === 'project-road-layout-v1' &&
              l.calculation.state === 'automatic',
          )),
    )
    const tokens = [
      ...incoming.map((post) => ({
        d:
          post.kind === 'sign-post' && post.distance
            ? (postMetres(post.distance, s.parameters.signDistancesMetres) ?? 0)
            : 0,
        post,
        node: undefined,
      })),
      ...nodes.map((node) => ({ d: node.position.metres, node, post: undefined })),
    ].sort((a, b) => a.d - b.d)
    const near = approach === 'left' ? anchors.L0 : anchors.E
    const available = approach === 'left' ? near - 5 : 1675 - near
    let chosen = 1
    for (const scale of [1, 0.85, 0.72, 0.6, 0.55, 0.5]) {
      const width = tokens.reduce(
        (sum, t) =>
          sum +
          (t.node
            ? 160
            : ((initial.objectBoxes.find((b) => b.id === t.post!.id)?.extent[2] ?? 80) /
                initialLayout.drawingScale(t.post!.id)) *
              scale) +
          8,
        0,
      )
      chosen = scale
      if (width < available) break
    }
    let cursor = near
    for (const token of tokens) {
      if (token.node) {
        const x = cursor + (approach === 'left' ? -88 : 88)
        const offset = x - anchors[token.node.position.from]
        s.roadLayout.nodes = s.roadLayout.nodes.map((n) =>
          n.id === token.node!.id ? { ...n, sheetOffsetXSvg: offset } : n,
        )
        const index = offsets.findIndex((o) => o.nodeId === token.node!.id)
        const value = { nodeId: token.node.id, offset }
        if (index < 0) offsets.push(value)
        else offsets[index] = value
        cursor += (approach === 'left' ? -1 : 1) * 168
        continue
      }
      const post = token.post!,
        box = initial.objectBoxes.find((b) => b.id === post.id)?.extent
      if (!box) continue
      const original = initialLayout.coordinates(post)
      const oldScale = initialLayout.drawingScale(post.id)
      const left = ((box[0] - original.x) / oldScale) * chosen,
        right = ((box[0] + box[2] - original.x) / oldScale) * chosen
      const x = approach === 'left' ? cursor - right : cursor - left
      const value = { placementId: post.id, x, y: original.y, scale: chosen },
        index = positions.findIndex((p) => p.placementId === post.id)
      if (index < 0) positions.push(value)
      else positions[index] = value
      cursor += (approach === 'left' ? -1 : 1) * ((box[2] / oldScale) * chosen + 8)
    }
  }
  s.roadLayout.automation!.layoutPositions = positions
  s.roadLayout.automation!.nodeOffsets = offsets
  for (const post of s.placements) {
    if (
      post.kind !== 'sign-post' ||
      !post.generatedByTemplate ||
      !/^post2:[LR]:end$/.test(post.templateSlot ?? '')
    )
      continue
    const approach = post.templateSlot!.startsWith('post2:L:') ? 'left' : 'right'
    if (!s.roadLayout.nodes.some((node) => node.position.approach === approach)) continue
    const value = {
      placementId: post.id,
      x: approach === 'left' ? anchors.L0 - 110 : anchors.E + 110,
      y: post.side === 'up' ? 353 : 567,
      scale: 1,
    }
    const index = positions.findIndex((p) => p.placementId === post.id)
    if (index < 0) positions.push(value)
    else positions[index] = value
  }
  s = {
    ...s,
    roadLayout: {
      ...s.roadLayout,
      nodes: s.roadLayout.nodes.map((node) =>
        node.kind === 'terminal-tee' && node.sheetOffsetXSvg === null
          ? {
              ...node,
              sheetOffsetXSvg:
                (node.position.approach === 'left' ? 80 : 1560) - anchors[node.position.from],
            }
          : node,
      ),
    },
  }
  const refresh = () => {
    s.roadLayout.automation!.basis = roadAutomationBasis(s, s.roadLayout.automation!.profile)
  }
  const draw = () => {
    refresh()
    return drawSheet(projectDraftSheet(s), {
      signSizes: new Map(),
      catalogLabel: '',
      revisionLabel: '',
    })
  }
  const targets = s.roadLayout.links.filter(
    (l) =>
      l.calculation?.ruleId === 'project-road-layout-v1' &&
      l.calculation.state === 'automatic' &&
      l.branchPlacement,
  )
  const targetIds = new Set(targets.map((l) => l.placementId)),
    placed = new Set<number>()
  for (const target of targets) {
    const original = target.branchPlacement!,
      node = s.roadLayout.nodes.find((n) => n.id === target.nodeId)!
    let found = false
    for (const along of [100, 140, 180, 220, 250, 300]) {
      if (found) break
      for (const across of [
        160, -160, 240, -240, 330, -330, 430, -430, 530, -530, 630, -630, 750, -750,
      ]) {
        const link = {
          ...target,
          branchPlacement: {
            ...original,
            scale: 0.6,
            alongSvg: along,
            acrossSvg: across * (node.position.approach === 'left' ? -1 : 1),
          },
        }
        s.roadLayout.links = s.roadLayout.links.map((item) =>
          item.placementId === target.placementId ? link : item,
        )
        const drawing = draw(),
          box = drawing.objectBoxes.find((item) => item.id === target.placementId)?.extent
        if (box && (original.branch === 'up' ? box[1] + box[3] > 378 : box[1] < 542)) continue
        if (!box || box[0] < 10 || box[1] < 215 || box[0] + box[2] > 1670 || box[1] + box[3] > 780)
          continue
        if (
          drawing.objectBoxes.some(
            (other) =>
              other.id !== target.placementId &&
              (!targetIds.has(other.id) || placed.has(other.id)) &&
              overlaps(box, other.extent),
          )
        )
          continue
        if (drawing.roadProblems?.some((problem) => problem.objectIds.includes(target.placementId)))
          continue
        found = true
        break
      }
    }
    if (!found)
      s.roadLayout.links = s.roadLayout.links.map((item) =>
        item.placementId === target.placementId ? target : item,
      )
    placed.add(target.placementId)
  }
  refresh()
  return s
}
