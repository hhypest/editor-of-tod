import { describe, expect, it } from 'vitest'
import { reactive } from 'vue'
import raw from '../../../tests/fixtures/frozen/projects/project-v12-native-b34.json?raw'
import { importSchemeJson, exportSchemeJson } from '../import'
import { schemeLayout } from '../placement-workspace'
import { projectRoadSheet, drawRoadSheet, roadObjectProblems } from '../road-sheet'
import { projectDraftSheet } from '../draft-sheet'
import { drawSheet } from '../sheet-drawing'
import { createRoadNodeDraft, saveRoadNode } from '../edit-road-nodes'
import { recoveryWriteSchema } from '../recovery'
import { roadLayoutProblem } from '../road-layout-readiness'
import type { RoadNode } from '../road-layout'

const options = { signSizes: new Map(), catalogLabel: 'Учебный', revisionLabel: 'Проверка' }
function project() {
  return importSchemeJson(raw).scheme
}
function junction(
  approach: 'left' | 'right',
  side: 'up' | 'down',
  metres = 120,
): Extract<RoadNode, { kind: 'junction' }> {
  return {
    id: 1,
    kind: 'junction',
    origin: 'manual',
    position:
      approach === 'left' ? { approach, from: 'L0', metres } : { approach, from: 'E', metres },
    side,
    roadKind: 'road',
    name: 'Альфа',
    sideWarningRequested: false,
    sheetOffsetXSvg: null,
  }
}
function draw(nodes: RoadNode[]) {
  const scheme = project(),
    { anchors, scale } = schemeLayout(scheme)
  return drawRoadSheet(projectRoadSheet(nodes, anchors, scale))
}

describe('conditional road geometry, independently of automatic placement rules', () => {
  it.each([
    ['left', 'up'],
    ['left', 'down'],
    ['right', 'up'],
    ['right', 'down'],
  ] as const)('projects %s/%s from its L0/E origin without moving objects', (approach, side) => {
    const scheme = project(),
      before = structuredClone(scheme)
    const { anchors, scale } = schemeLayout(scheme)
    const node = junction(approach, side)
    const projected = projectRoadSheet(reactive([node]), anchors, scale)
    expect(projected.nodes[0]!.x).toBe(
      anchors[approach === 'left' ? 'L0' : 'E'] + scale.x(approach, 120) - scale.x(approach, 0),
    )
    expect(
      approach === 'left' ? projected.nodes[0]!.x < anchors.L0 : projected.nodes[0]!.x > anchors.E,
    ).toBe(true)
    const drawing = drawRoadSheet(projected)
    expect(drawing.boxes).toHaveLength(1)
    expect(
      side === 'up' ? drawing.boxes[0]!.branch[1] < 380 : drawing.boxes[0]!.branch[1] >= 540,
    ).toBe(true)
    expect(drawing.nodes.find((n) => n.t === 'group' && n.roadNodeId === 1)).toBeTruthy()
    expect(scheme).toEqual(before)
  })

  it('places zero metres exactly at L0/E, and rejects unrepresentable extrapolation in the drawing', () => {
    const scheme = project(),
      { anchors, scale } = schemeLayout(scheme)
    for (const approach of ['left', 'right'] as const) {
      const node = junction(approach, 'up', 0)
      expect(projectRoadSheet([node], anchors, scale).nodes[0]!.x).toBe(
        anchors[approach === 'left' ? 'L0' : 'E'],
      )
      const overflow = projectRoadSheet([node], anchors, {
        x: (_, metres) => (metres === 0 ? 0 : Infinity),
      })
      node.position.metres = 1
      const actual = projectRoadSheet([node], anchors, {
        x: (_, metres) => (metres === 0 ? 0 : Infinity),
      })
      expect(Number.isFinite(actual.nodes[0]!.x)).toBe(true)
      expect(
        drawRoadSheet(actual).problems.some((p) => p.code === 'road-coordinate-overflow'),
      ).toBe(true)
      expect(overflow.nodes[0]!.coordinateOverflow).toBe(false)
    }
  })

  it('keeps drawing offset independent, including zero, and uses no source JSON', () => {
    const scheme = project(),
      { anchors, scale } = schemeLayout(scheme)
    const node = junction('left', 'down')
    node.sheetOffsetXSvg = -211
    expect(projectRoadSheet([node], anchors, scale).nodes[0]!.x).toBe(anchors.L0 - 211)
    node.sheetOffsetXSvg = 0
    expect(projectRoadSheet([node], anchors, scale).nodes[0]!.x).toBe(anchors.L0)
    expect(node.position.metres).toBe(120)
  })

  it.each(['left', 'right'] as const)(
    'terminates the %s approach with both named branches, with no straight continuation',
    (approach) => {
      const node: RoadNode = {
        id: 2,
        kind: 'terminal-tee',
        origin: 'manual',
        position:
          approach === 'left'
            ? { approach, from: 'L0', metres: 200 }
            : { approach, from: 'E', metres: 200 },
        sheetOffsetXSvg: null,
        branchNames: { up: 'Север', down: 'Юг' },
      }
      const drawing = draw([node]),
        scheme = project()
      const { anchors, scale } = schemeLayout(scheme)
      const x =
        anchors[approach === 'left' ? 'L0' : 'E'] + scale.x(approach, 200) - scale.x(approach, 0)
      expect(drawing.boxes.map((b) => b.branch[1])).toEqual([276, 540])
      const main = drawing.nodes[0]!
      expect(main.t).toBe('rect')
      if (main.t !== 'rect') throw Error('Road rectangle required')
      expect(approach === 'left' ? main.x : main.x + main.w).toBeCloseTo(
        approach === 'left' ? x - 80 : x + 80,
      )
      const group = drawing.nodes.find((n) => n.t === 'group')!
      if (group.t !== 'group') throw Error('Branches required')
      expect(group.children.filter((n) => n.t === 'text').map((n) => n.text)).toEqual(
        expect.arrayContaining([
          'Север',
          'Юг',
          `№ 2 · 200 м от ${approach === 'left' ? 'L0' : 'E'}`,
        ]),
      )
      expect(projectRoadSheet([node], anchors, scale).nodes[0]!.position.metres).toBe(200)
    },
  )

  it('reports overlapping branches/captions, long names and off-sheet geometry without hiding nodes', () => {
    const a = junction('left', 'up'),
      b = { ...junction('left', 'up'), id: 2 }
    a.name = 'очень длинное название '.repeat(30)
    a.sheetOffsetXSvg = -520
    b.sheetOffsetXSvg = -510
    const result = draw([a, b])
    expect(result.problems.map((p) => p.code)).toEqual(
      expect.arrayContaining(['road-name-overflow', 'road-outside-sheet', 'road-node-overlap']),
    )
    expect(result.nodes.filter((n) => n.t === 'group')).toHaveLength(2)
    expect(result.problems.filter((p) => p.code === 'road-node-overlap')).toHaveLength(1)
  })

  it('checks topology from metres even when a sheet offset makes the picture look plausible', () => {
    const tee: RoadNode = {
      id: 2,
      kind: 'terminal-tee',
      origin: 'manual',
      position: { approach: 'right', from: 'E', metres: 100 },
      sheetOffsetXSvg: 320,
      branchNames: { up: '', down: '' },
    }
    const behind = junction('right', 'up', 120)
    behind.sheetOffsetXSvg = 180
    expect(draw([behind, tee]).problems).toContainEqual(
      expect.objectContaining({ code: 'road-beyond-tee', nodeIds: [1, 2] }),
    )
    behind.position.metres = 100
    expect(draw([behind, tee]).problems.some((p) => p.code === 'road-beyond-tee')).toBe(true)
    behind.position.metres = 99
    expect(draw([behind, tee]).problems.some((p) => p.code === 'road-beyond-tee')).toBe(false)
    behind.position = { approach: 'left', from: 'L0', metres: 120 }
    expect(draw([behind, tee]).problems.some((p) => p.code === 'road-beyond-tee')).toBe(false)
  })

  it('does not let conditional offsets hide a through crossing or reverse the physical node order', () => {
    const a = junction('left', 'up', 100),
      b = { ...junction('left', 'down', 100), id: 2 }
    a.sheetOffsetXSvg = -400
    b.sheetOffsetXSvg = -100
    expect(draw([a, b]).problems.some((p) => p.code === 'road-through-crossing')).toBe(true)
    b.position.metres = 200
    expect(draw([a, b]).problems.some((p) => p.code === 'road-through-crossing')).toBe(false)
    expect(draw([a, b]).problems.some((p) => p.code === 'road-order-reversed')).toBe(true)
  })

  it('reports inward offsets and drawing intersection with work section without changing semantic distance', () => {
    const node = junction('left', 'down', 15)
    node.sheetOffsetXSvg = 40
    expect(draw([node]).problems.map((p) => p.code)).toEqual(
      expect.arrayContaining(['road-sheet-inward', 'road-work-zone-overlap']),
    )
    expect(node.position.metres).toBe(15)
  })

  it('reports preserved object collisions by separate node/object IDs, including the caption extent', () => {
    const node = junction('left', 'up'),
      drawn = draw([node]),
      box = drawn.boxes[0]!
    expect(
      roadObjectProblems(drawn.boxes, [
        { id: 1, box: [...box.branch], extent: [...box.branch] },
        { id: 42, box: [1000, 900, 10, 10], extent: [...box.caption] },
      ]),
    ).toEqual([expect.objectContaining({ nodeIds: [1], objectIds: [1, 42] })])
  })

  it('keeps posts drawn beyond the terminus and identifies them without choosing a transfer rule', () => {
    const scheme = project(),
      layout = schemeLayout(scheme)
    const tee = scheme.roadLayout.nodes.find((node) => node.kind === 'terminal-tee')!
    const projected = projectRoadSheet([tee], layout.anchors, layout.scale).nodes[0]!
    projected.x = 1400
    projected.position = { approach: 'right', from: 'E', metres: 200 }
    const objects = [
      {
        id: 72,
        kind: 'sign-post',
        box: [1550, 340, 40, 40] as [number, number, number, number],
        extent: [1550, 340, 40, 40] as [number, number, number, number],
      },
    ]
    const before = structuredClone(objects)
    expect(roadObjectProblems([], objects, projected)).toEqual([
      expect.objectContaining({
        code: 'road-objects-beyond-tee',
        nodeIds: [tee.id],
        objectIds: [72],
      }),
    ])
    expect(objects).toEqual(before)
  })

  it('passes the same branch drawing into A4/PNG and preserves the full project', () => {
    const scheme = project(),
      before = structuredClone(scheme),
      layout = schemeLayout(scheme)
    const sheet = projectDraftSheet(scheme),
      drawing = drawSheet(sheet, options)
    const direct = drawRoadSheet(
      projectRoadSheet(scheme.roadLayout.nodes, layout.anchors, layout.scale),
    )
    expect(drawing.nodes.filter((n) => n.t === 'group' && n.roadNodeId)).toEqual(
      direct.nodes.filter((n) => n.t === 'group'),
    )
    expect(importSchemeJson(exportSchemeJson(scheme)).scheme).toEqual(scheme)
    expect(roadLayoutProblem(scheme)).toBeTruthy()
    expect(scheme).toEqual(before)
  })

  it('edits conditional offset with comma/zero/reset, recovers partial input, and retains old working forms', () => {
    const scheme = project(),
      node = scheme.roadLayout.nodes[0]!,
      draft = createRoadNodeDraft(node)
    draft.sheetOffsetXSvg = '-210,5'
    const changed = saveRoadNode(scheme, draft)
    expect(changed.roadLayout.nodes[0]!.sheetOffsetXSvg).toBe(-210.5)
    expect(changed.placements).toEqual(scheme.placements)
    expect(changed.roadLayout.links).toEqual(scheme.roadLayout.links)
    expect(changed.roadLayout.nodes[0]!.position).toEqual(node.position)
    draft.sheetOffsetXSvg = '0'
    expect(saveRoadNode(scheme, draft).roadLayout.nodes[0]!.sheetOffsetXSvg).toBe(0)
    draft.sheetOffsetXSvg = ''
    expect(saveRoadNode(scheme, draft).roadLayout.nodes[0]!.sheetOffsetXSvg).toBeNull()
    delete draft.sheetOffsetXSvg
    expect(saveRoadNode(scheme, draft).roadLayout.nodes[0]!.sheetOffsetXSvg).toBe(
      node.sheetOffsetXSvg,
    )
    draft.sheetOffsetXSvg = '-'
    expect(() => saveRoadNode(scheme, draft)).toThrow('Условный отступ рисунка')
    const recovery = {
      sessionId: crypto.randomUUID(),
      scheme,
      baseRevision: null,
      detailsDraft: null,
      fileName: 'учебный.json',
      expectedVersion: 0,
      placementDraft: draft,
    }
    expect(recoveryWriteSchema.parse(JSON.parse(JSON.stringify(recovery))).placementDraft).toEqual(
      draft,
    )
  })
})
