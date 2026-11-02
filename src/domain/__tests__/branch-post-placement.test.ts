import { describe, expect, it } from 'vitest'
import raw from '../../../tests/fixtures/frozen/projects/project-v12-native-b34.json?raw'
import { importSchemeJson, exportSchemeJson } from '../import'
import { schemeSchema, schemeV12Schema, parseStoredScheme } from '../model'
import { createPlacementDraft, newSignDraft, savePlacement } from '../edit-placements'
import { createRoadObjectLinkDraft } from '../road-object-link-draft'
import { schemeLayout, movePlacement, stepPostDistance } from '../placement-workspace'
import { projectDraftSheet } from '../draft-sheet'
import { drawSheet } from '../sheet-drawing'
import { rotatePostBox } from '../branch-post-geometry'
import { startHistory, recordEdit, undoEdit, redoEdit } from '../edit-history'
import { createRoadNodeDraft, saveRoadNode } from '../edit-road-nodes'
import { roadLayoutProblem } from '../road-layout-readiness'
import type { BranchPlacement } from '../road-layout'

const options = { signSizes: new Map(), catalogLabel: 'Учебный', revisionLabel: 'Проверка' }
function setup(
  approach: 'left' | 'right' = 'left',
  side: 'up' | 'down' = 'down',
  rotation: BranchPlacement['rotation'] = 90,
) {
  const scheme = importSchemeJson(raw).scheme,
    node = scheme.roadLayout.nodes[0]!
  if (node.kind !== 'junction') throw Error('Junction expected')
  node.position =
    approach === 'left'
      ? { approach, from: 'L0', metres: 120 }
      : { approach, from: 'E', metres: 120 }
  node.side = side
  const post = scheme.placements[0]!,
    draft = createPlacementDraft(post, scheme.roadLayout)
  if (draft.kind !== 'sign-post' || !draft.roadLink) throw Error('Post expected')
  draft.roadLink.role = 'side-warning'
  draft.roadLink.installationKnown = true
  draft.roadLink.installationFrom = 'L0'
  draft.roadLink.installationMetres = '50'
  draft.roadLink.branchPlacement = {
    enabled: true,
    branch: side,
    alongSvg: '160',
    acrossSvg: '190',
    rotation: String(rotation) as '0' | '90' | '180' | '270',
  }
  return { scheme, post, draft, attached: savePlacement(scheme, draft) }
}

describe('explicit branch positions and independent v13 codec', () => {
  it('freezes v12, upgrades only its envelope and never infers branch adoption', () => {
    const v12 = schemeV12Schema.parse(JSON.parse(raw)),
      current = importSchemeJson(raw)
    expect(current.format).toBe('scheme-v12')
    expect(current.scheme).toEqual({ ...v12, schemaVersion: 13 })
    expect(parseStoredScheme(v12)).toEqual(current.scheme)
    expect(
      current.scheme.roadLayout.links.every((link) => link.branchPlacement === undefined),
    ).toBe(true)
    const { attached } = setup()
    expect(schemeV12Schema.safeParse({ ...attached, schemaVersion: 12 }).success).toBe(false)
    expect(importSchemeJson(exportSchemeJson(attached))).toMatchObject({
      format: 'scheme-v13',
      scheme: attached,
    })
  })

  it.each([
    ['left', 'up'],
    ['left', 'down'],
    ['right', 'up'],
    ['right', 'down'],
  ] as const)(
    'projects %s/%s in conditional units without changing physical or main-road data',
    (approach, side) => {
      const { scheme, attached, post } = setup(approach, side),
        layout = schemeLayout(attached)
      const projected = layout.branch(post.id)!,
        nodeX = projectDraftSheet(attached).roadSheet.nodes.find((node) => node.id === 1)!.x
      expect(projected).toMatchObject({
        x: nodeX + 190,
        y: side === 'up' ? 300 : 620,
        rotation: 90,
        nodeId: 1,
      })
      expect(attached.placements[0]).toMatchObject({
        position: post.position,
        distance: post.kind === 'sign-post' ? post.distance : null,
        generatedByTemplate: false,
      })
      expect(attached.placements.slice(1)).toEqual(scheme.placements.slice(1))
      expect(attached.roadLayout.nodes).toEqual(scheme.roadLayout.nodes)
      expect(attached.roadLayout.links[0]!.installation).toEqual({ from: 'L0', metres: 50 })
      const drawing = drawSheet(projectDraftSheet(attached), options),
        group = drawing.nodes.find((node) => node.t === 'group' && node.objectId === post.id)
      expect(group).toMatchObject({ rotation: { degrees: 90, cx: projected.x, cy: projected.y } })
      expect(drawing.objectBoxes.find((box) => box.id === post.id)?.roadBranchNodeId).toBe(1)
      const projectedPost = projectDraftSheet(attached).placements[0]!
      expect(projectedPost).toMatchObject({
        x: projected.x,
        y: projected.y,
        distanceLabel: '50 м от L0',
      })
    },
  )

  it.each([0, 90, 180, 270] as const)(
    'bounds signs and annotations after an exact %d degree turn',
    (rotation) => {
      const box: [number, number, number, number] = [90, 180, 40, 80]
      const turned = rotatePostBox(box, 100, 200, rotation)
      expect(turned.every(Number.isFinite)).toBe(true)
      expect(turned.slice(2)).toEqual(rotation === 90 || rotation === 270 ? [80, 40] : [40, 80])
      // Four quarter turns return exactly; no trigonometric epsilon at the sheet boundary.
      let current = box
      for (let n = 0; n < 4; n++) current = rotatePostBox(current, 100, 200, 90)
      expect(current).toEqual(box)
      const { attached, post } = setup('left', 'down', rotation)
      const drawing = drawSheet(projectDraftSheet(attached), options)
      expect(
        drawing.objectBoxes.find((item) => item.id === post.id)?.extent.every(Number.isFinite),
      ).toBe(true)
    },
  )

  it('moves branch drawing only, keeps measurements, and undoes the whole move', () => {
    const { attached, post } = setup(),
      before = structuredClone(attached),
      layout = schemeLayout(attached)
    const moved = movePlacement(attached, post.id, 20, 30)
    expect(schemeLayout(moved).coordinates(post)).toMatchObject({
      x: layout.coordinates(post).x + 20,
      y: layout.coordinates(post).y + 30,
    })
    expect(moved.placements).toEqual(attached.placements)
    expect(moved.roadLayout.links[0]).toMatchObject({
      installation: { from: 'L0', metres: 50 },
      branchPlacement: { alongSvg: 190, acrossSvg: 210 },
    })
    const history = recordEdit(startHistory(attached), moved)
    expect(undoEdit(history).present).toEqual(attached)
    expect(redoEdit(undoEdit(history)).present).toEqual(moved)
    expect(() => stepPostDistance(attached, post.id, 5)).toThrow('условных единицах')
    expect(() => movePlacement(attached, post.id, 0, -161)).toThrow('другую ветвь')
    expect(() => movePlacement(attached, post.id, 1_000_001, 0)).toThrow('условные границы')
    expect(attached).toEqual(before)
  })

  it('creates a new branch post without requiring a hidden main-road distance', () => {
    const { scheme, draft: linked } = setup(),
      draft = newSignDraft('left')
    if (draft.kind !== 'sign-post' || linked.kind !== 'sign-post') throw Error('Post expected')
    draft.signCodes = '1.25'
    draft.roadLink = linked.roadLink
    const next = savePlacement(scheme, draft),
      post = next.placements.at(-1)!
    expect(post).toMatchObject({
      kind: 'sign-post',
      distance: null,
      distanceLabel: null,
      position: { anchor: 'abs', offsetXSvg: 0, offsetYSvg: 0 },
    })
    expect(next.roadLayout.links.find((link) => link.placementId === post.id)).toMatchObject({
      branchPlacement: { branch: 'down', alongSvg: 160, acrossSvg: 190, rotation: 90 },
      installation: { from: 'L0', metres: 50 },
    })
    expect(next.placements.slice(0, -1)).toEqual(scheme.placements)
  })

  it('restores the retained main-road position after explicit detach and rejects silent target changes', () => {
    const { scheme, attached, post } = setup(),
      draft = createPlacementDraft(attached.placements[0]!, attached.roadLayout)
    if (draft.kind !== 'sign-post' || !draft.roadLink?.branchPlacement)
      throw Error('Branch input expected')
    const old = createRoadObjectLinkDraft(attached.roadLayout.links[0])
    delete old.branchPlacement
    draft.roadLink = old
    expect(savePlacement(attached, draft).roadLayout.links[0]!.branchPlacement).toEqual(
      attached.roadLayout.links[0]!.branchPlacement,
    )
    draft.roadLink.nodeId = ''
    expect(() => savePlacement(attached, draft)).toThrow('Сначала явно снимите')
    const secondNode = structuredClone(attached)
    secondNode.roadLayout.nodes.push({ ...secondNode.roadLayout.nodes[0]!, id: 4 })
    secondNode.roadLayout.nextNodeId = 5
    draft.roadLink = createRoadObjectLinkDraft(attached.roadLayout.links[0])
    draft.roadLink.nodeId = '4'
    expect(() => savePlacement(secondNode, draft)).toThrow('Сначала явно снимите')
    draft.roadLink = createRoadObjectLinkDraft(attached.roadLayout.links[0])
    draft.roadLink.branchPlacement!.enabled = false
    const detached = savePlacement(attached, draft)
    expect(detached.roadLayout.links[0]!.branchPlacement).toBeUndefined()
    expect(schemeLayout(detached).coordinates(detached.placements[0]!)).toEqual(
      schemeLayout(scheme).coordinates(post),
    )
  })

  it('follows its explicit node without moving other objects, and prevents changing to an incompatible side', () => {
    const { attached, post } = setup(),
      node = attached.roadLayout.nodes[0]!,
      draft = createRoadNodeDraft(node)
    draft.sheetOffsetXSvg = '-240'
    const first = saveRoadNode(attached, draft)
    draft.sheetOffsetXSvg = '-220'
    const second = saveRoadNode(first, draft)
    expect(schemeLayout(second).coordinates(post).x - schemeLayout(first).coordinates(post).x).toBe(
      20,
    )
    expect(schemeLayout(second).coordinates(second.placements[1]!)).toEqual(
      schemeLayout(first).coordinates(first.placements[1]!),
    )
    draft.side = 'up'
    expect(() => saveRoadNode(second, draft)).toThrow('Ветвь стойки')
  })

  it.each(['', '-', '-1', 'Infinity', '1000001'])(
    'refuses invalid along offset %j without applying partial geometry',
    (alongSvg) => {
      const { scheme, draft } = setup(),
        before = structuredClone(scheme)
      if (draft.kind !== 'sign-post' || !draft.roadLink?.branchPlacement)
        throw Error('Branch input expected')
      draft.roadLink.branchPlacement.alongSvg = alongSvg
      expect(() => savePlacement(scheme, draft)).toThrow('Размещение на ветви')
      expect(scheme).toEqual(before)
    },
  )

  it('retains the release/rebuild guard even for explicit, valid branch placement', () => {
    expect(roadLayoutProblem(setup().attached)).toBeTruthy()
    expect(schemeSchema.shape.schemaVersion.value).toBe(13)
  })
})
