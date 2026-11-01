import type { RoadNode } from './road-layout'
import type { PostScale } from './post-distance'
import type { ZoneAnchors } from './zone-geometry'
import type { SheetNode } from './sheet-nodes'
import { decimalComma } from './number-format'
import { textWidth, wrapText } from './sheet-text'

type Box = [number, number, number, number]
export type RoadSheetNode = RoadNode & { x: number; coordinateOverflow: boolean }
export type RoadSheet = { nodes: RoadSheetNode[]; anchors: ZoneAnchors }
export type RoadSheetProblem = {
  code: string
  nodeIds: number[]
  objectIds: number[]
  message: string
}
export type RoadNodeBox = { id: number; branch: Box; caption: Box }

// Conditional drawing units only. These widths/lengths are not physical dimensions or rules.
const WIDTH = 1680
const TOP = 380
const BOTTOM = 540
const BRANCH_TOP = 276
const BRANCH_BOTTOM = 650

/** D2: use the L0/E origin, never a work-front anchor or an inverted pixel-to-metre value. */
export function projectRoadSheet(
  nodes: readonly RoadNode[],
  anchors: ZoneAnchors,
  scale: Pick<PostScale, 'x'>,
): RoadSheet {
  return {
    anchors: { ...anchors },
    nodes: nodes.map((node) => {
      const x =
        node.sheetOffsetXSvg === null
          ? anchors[node.position.from] +
            scale.x(node.position.approach, node.position.metres) -
            scale.x(node.position.approach, 0)
          : anchors[node.position.from] + node.sheetOffsetXSvg
      return {
        ...node,
        position: { ...node.position },
        ...(node.kind === 'terminal-tee' ? { branchNames: { ...node.branchNames } } : {}),
        // Non-finite extrapolation cannot be sent to SVG. Keep it visibly outside, with a blocker.
        x: Number.isFinite(x) ? x : node.position.approach === 'left' ? -WIDTH : WIDTH * 2,
        coordinateOverflow: !Number.isFinite(x),
      }
    }),
  }
}

function intersects(a: Box, b: Box): boolean {
  return a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3]
}

/** Same drawing for the object workspace, A4 preview, printing and PNG. No object is moved here. */
export function drawRoadSheet(sheet: RoadSheet): {
  nodes: SheetNode[]
  boxes: RoadNodeBox[]
  problems: RoadSheetProblem[]
} {
  const nodes: SheetNode[] = []
  const boxes: RoadNodeBox[] = []
  const problems: RoadSheetProblem[] = []
  const problemKeys = new Set<string>()
  let moreProblems = false
  const problem = (code: string, nodeIds: number[], message: string) => {
    const key = `${code}:${nodeIds.join(',')}`
    if (problemKeys.has(key)) return
    if (problems.length >= 100) {
      moreProblems = true
      return
    }
    problemKeys.add(key)
    problems.push({ code, nodeIds, objectIds: [], message })
  }
  const tee = sheet.nodes.find((node) => node.kind === 'terminal-tee')
  const start = tee?.position.approach === 'left' ? tee.x - 80 : 0
  const end = tee?.position.approach === 'right' ? tee.x + 80 : WIDTH
  const roadStart = Math.max(0, Math.min(WIDTH, start))
  const roadEnd = Math.max(roadStart, Math.min(WIDTH, end))
  const laneStart =
    tee?.position.approach === 'left'
      ? Math.min(roadEnd, Math.max(roadStart, tee.x - 60))
      : roadStart
  const laneEnd =
    tee?.position.approach === 'right'
      ? Math.max(laneStart, Math.min(roadEnd, tee.x + 60))
      : roadEnd
  nodes.push(
    { t: 'rect', x: roadStart, y: TOP, w: roadEnd - roadStart, h: BOTTOM - TOP, fill: '#e7e7e7' },
    { t: 'rect', x: laneStart, y: 400, w: laneEnd - laneStart, h: 120, fill: '#bdbdbd' },
  )
  for (const [side, y] of [
    ['up', 401.5],
    ['down', 518.5],
  ] as const) {
    const gaps = sheet.nodes
      .filter((node) => node.kind === 'terminal-tee' || node.side === side)
      .map(
        (node) =>
          [
            node.x - (node.kind === 'junction' && node.roadKind === 'yard' ? 40 : 60),
            node.x + (node.kind === 'junction' && node.roadKind === 'yard' ? 40 : 60),
          ] as const,
      )
      .sort((a, b) => a[0] - b[0])
    let cursor = laneStart
    for (const [left, right] of gaps) {
      if (left > cursor)
        nodes.push({
          t: 'line',
          x1: cursor,
          y1: y,
          x2: Math.min(left, laneEnd),
          y2: y,
          stroke: '#fff',
          sw: 3,
        })
      cursor = Math.max(cursor, right)
      if (cursor >= laneEnd) break
    }
    if (cursor < laneEnd)
      nodes.push({ t: 'line', x1: cursor, y1: y, x2: laneEnd, y2: y, stroke: '#fff', sw: 3 })
  }
  nodes.push({
    t: 'line',
    x1: laneStart,
    y1: 460,
    x2: laneEnd,
    y2: 460,
    stroke: '#fff',
    sw: 1.6,
    dash: '18 14',
  })

  for (const node of sheet.nodes) {
    const { x, id } = node
    const yard = node.kind === 'junction' && node.roadKind === 'yard'
    const half = yard ? 55 : 80
    const laneHalf = yard ? 40 : 60
    const children: SheetNode[] = []
    const sides = node.kind === 'terminal-tee' ? (['up', 'down'] as const) : [node.side]
    for (const side of sides) {
      const up = side === 'up'
      const y = up ? BRANCH_TOP : 520
      const bottom = up ? 400 : BRANCH_BOTTOM
      const caption = `№ ${id} · ${decimalComma(node.position.metres)} м от ${node.position.from}`
      const captionWidth = textWidth(caption, 12)
      boxes.push({
        id,
        branch: [
          x - half,
          up ? BRANCH_TOP : BOTTOM,
          half * 2,
          up ? TOP - BRANCH_TOP : BRANCH_BOTTOM - BOTTOM,
        ],
        caption: [x - captionWidth / 2, up ? 257 : 671, captionWidth, 16],
      })
      children.push(
        { t: 'rect', x: x - half, y, w: half * 2, h: bottom - y, fill: '#e7e7e7' },
        { t: 'rect', x: x - laneHalf, y, w: laneHalf * 2, h: bottom - y, fill: '#bdbdbd' },
        {
          t: 'line',
          x1: x - laneHalf + 1.5,
          y1: y,
          x2: x - laneHalf + 1.5,
          y2: bottom,
          stroke: '#fff',
          sw: 3,
        },
        {
          t: 'line',
          x1: x + laneHalf - 1.5,
          y1: y,
          x2: x + laneHalf - 1.5,
          y2: bottom,
          stroke: '#fff',
          sw: 3,
        },
        {
          t: 'text',
          x,
          y: up ? 270 : 684,
          text: caption,
          size: 12,
          anchor: 'middle',
          cls: 'road-node-caption',
        },
      )
      if (!yard)
        children.push({
          t: 'line',
          x1: x,
          y1: y,
          x2: x,
          y2: bottom,
          stroke: '#fff',
          sw: 1.6,
          dash: '12 10',
        })
      if (!yard) {
        const arrowY = up ? 305 : 585
        children.push(
          { t: 'path', d: `M${x + 30} ${arrowY} l-6 10 h4 v20 h4 v-20 h4 z`, fill: '#fff' },
          { t: 'path', d: `M${x - 30} ${arrowY + 30} l-6 -10 h4 v-20 h4 v20 h4 z`, fill: '#fff' },
        )
      }
      const name = node.kind === 'terminal-tee' ? node.branchNames[side] : node.name
      const label =
        name.trim() || (node.kind === 'terminal-tee' ? 'без названия' : yard ? 'выезд' : 'дорога')
      const lines = wrapText(label, 96, 12)
      if (lines.length > 2)
        problem(
          'road-name-overflow',
          [id],
          `Узел № ${id}: название ${up ? 'верхней' : 'нижней'} ветви не помещается. Сократите название.`,
        )
      for (const [index, line] of lines.slice(0, 2).entries())
        children.push({
          t: 'text',
          x: x - 13 + index * 14,
          y: up ? 371 : 552,
          text: lines.length > 2 && index === 1 ? `${line}…` : line,
          size: 12,
          rotate: up ? -90 : 90,
        })
    }
    // At a terminus the outer edge closes the main road; there is no straight continuation.
    if (node.kind === 'terminal-tee') {
      const outer = x + (node.position.approach === 'right' ? 60 : -60)
      children.push(
        { t: 'rect', x: x - 60, y: 400, w: 120, h: 120, fill: '#bdbdbd' },
        { t: 'line', x1: x, y1: 400, x2: x, y2: 520, stroke: '#fff', sw: 1.6, dash: '12 10' },
        {
          t: 'line',
          x1: outer,
          y1: BRANCH_TOP,
          x2: outer,
          y2: BRANCH_BOTTOM,
          stroke: '#fff',
          sw: 3,
        },
      )
    }
    nodes.push({ t: 'group', roadNodeId: id, cls: `road-node ${node.kind}`, children })
    if (node.coordinateOverflow)
      problem(
        'road-coordinate-overflow',
        [id],
        `Узел № ${id}: расстояние слишком велико для рисунка. Уточните расстояние или задайте условный отступ.`,
      )
    if (
      (node.position.approach === 'left' && x > sheet.anchors.L0) ||
      (node.position.approach === 'right' && x < sheet.anchors.E)
    )
      problem(
        'road-sheet-inward',
        [id],
        `Узел № ${id}: условный отступ помещает рисунок внутри участка работ. Исправьте отступ; расстояние до оси сохранено.`,
      )
    if (
      tee &&
      node.kind === 'junction' &&
      node.position.approach === tee.position.approach &&
      node.position.metres >= tee.position.metres
    )
      problem(
        'road-beyond-tee',
        [id, tee.id],
        `Примыкание № ${id} находится на оси или за конечным Т-перекрёстком № ${tee.id}. Проверьте топологию и расстояния.`,
      )
  }
  for (const box of boxes) {
    if (
      [box.branch, box.caption].some(
        ([x, y, w, h]) => x < 0 || y < 0 || x + w > WIDTH || y + h > 1188,
      )
    )
      problem(
        'road-outside-sheet',
        [box.id],
        `Узел № ${box.id}: ветвь или подпись выходит за лист. Исправьте условный отступ рисунка.`,
      )
    if (
      intersects(box.branch, [
        sheet.anchors.L0,
        TOP - 1,
        sheet.anchors.E - sheet.anchors.L0,
        BOTTOM - TOP + 2,
      ])
    )
      problem(
        'road-work-zone-overlap',
        [box.id],
        `Узел № ${box.id}: ветвь на рисунке перекрывает участок работ. Разведите рисунок условным отступом, сохранив метры.`,
      )
  }
  for (const approach of ['left', 'right'] as const) {
    const ordered = sheet.nodes
      .filter((node) => node.position.approach === approach)
      .sort((a, b) => a.position.metres - b.position.metres || a.id - b.id)
    for (let index = 1; index < ordered.length; index++) {
      const near = ordered[index - 1]!,
        far = ordered[index]!
      if (
        far.position.metres > near.position.metres &&
        (approach === 'left' ? far.x > near.x : far.x < near.x)
      )
        problem(
          'road-order-reversed',
          [near.id, far.id],
          `Узлы № ${near.id} и № ${far.id}: порядок рисунка противоречит расстояниям. Исправьте условные отступы; метры сохранены.`,
        )
    }
    const axes = new Map<number, RoadSheetNode>()
    for (const node of ordered) {
      if (node.kind !== 'junction') continue
      const opposite = axes.get(node.position.metres)
      if (opposite?.kind === 'junction' && opposite.side !== node.side)
        problem(
          'road-through-crossing',
          [opposite.id, node.id],
          `Примыкания № ${opposite.id} и № ${node.id} заданы на одной оси с противоположных сторон. Сквозной перекрёсток не входит в объём 0.3.0; проверьте топологию и расстояния.`,
        )
      axes.set(node.position.metres, node)
    }
  }
  pairs: for (let i = 0; i < boxes.length; i++)
    for (let j = i + 1; j < boxes.length; j++) {
      if (moreProblems) break pairs
      const a = boxes[i]!,
        b = boxes[j]!
      if (a.id !== b.id && (intersects(a.branch, b.branch) || intersects(a.caption, b.caption)))
        problem(
          'road-node-overlap',
          [a.id, b.id],
          `Узлы № ${a.id} и № ${b.id}: ветви или подписи перекрываются. Разведите рисунок условными отступами; метры не меняются.`,
        )
    }
  if (moreProblems)
    problems.push({
      code: 'road-more-problems',
      nodeIds: [],
      objectIds: [],
      message:
        'Показаны первые 100 замечаний к примыканиям. Исправьте их; остальные будут показаны после пересчёта.',
    })
  return { nodes, boxes, problems }
}

/** Layout conflicts only, not normative conclusions. Preserved objects are never relocated/deleted. */
export function roadObjectProblems(
  boxes: readonly RoadNodeBox[],
  objects: readonly { id: number; kind?: string; box: Box; extent: Box }[],
  tee?: RoadSheetNode,
): RoadSheetProblem[] {
  const result: RoadSheetProblem[] = []
  for (const nodeId of new Set(boxes.map((box) => box.id))) {
    const own = boxes.filter((box) => box.id === nodeId)
    const objectIds = objects
      .filter((object) =>
        own.some(
          (box) => intersects(box.branch, object.box) || intersects(box.caption, object.extent),
        ),
      )
      .map((object) => object.id)
    if (objectIds.length)
      result.push({
        code: 'road-object-overlap',
        nodeIds: [nodeId],
        objectIds,
        message: `Узел № ${nodeId}: ветвь или подпись перекрывает объекты № ${objectIds.join(', ')}. Объекты сохранены на своих местах; проверьте компоновку.`,
      })
  }
  if (tee) {
    const objectIds = objects
      .filter(
        (object) =>
          object.kind === 'sign-post' &&
          (tee.position.approach === 'right'
            ? object.box[0] > tee.x + 80
            : object.box[0] + object.box[2] < tee.x - 80),
      )
      .map((object) => object.id)
    if (objectIds.length)
      result.push({
        code: 'road-objects-beyond-tee',
        nodeIds: [tee.id],
        objectIds,
        message: `За конечным Т-перекрёстком № ${tee.id} на рисунке остались стойки № ${objectIds.join(', ')}. Их перенос на обе ветви ещё не реализован; стойки сохранены без перемещения.`,
      })
  }
  return result
}
