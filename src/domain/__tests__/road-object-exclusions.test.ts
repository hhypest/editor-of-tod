import { describe, expect, it } from 'vitest'
import raw from '../../../tests/fixtures/frozen/projects/project-v13-branch-b34.json?raw'
import { importSchemeJson, exportSchemeJson } from '../import'
import { schemeSchema, schemeV13Schema } from '../model'
import {
  removePlacement,
  restoreRoadPlacement,
  newSignDraft,
  savePlacement,
} from '../edit-placements'
import { schemeLayout } from '../placement-workspace'
import { drawSheet } from '../sheet-drawing'
import { projectDraftSheet } from '../draft-sheet'
import { removeRoadNode, createRoadNodeDraft, saveRoadNode } from '../edit-road-nodes'
import { startHistory, recordEdit, undoEdit, redoEdit } from '../edit-history'
import { usedSignCodes, clearPinsAfterSignChange, pinSignImages } from '../sign-images'
import { roadLayoutProblem } from '../road-layout-readiness'

const options = { signSizes: new Map(), catalogLabel: '', revisionLabel: '' }
const example = () => importSchemeJson(raw).scheme

describe('reversible road-post exclusion, v14', () => {
  it('freezes v13 and changes only the envelope when opening an old project', () => {
    const old = schemeV13Schema.parse(JSON.parse(raw)),
      current = example()
    expect(current).toEqual({ ...old, schemaVersion: 14 })
    expect(current.roadObjectExclusions).toBeUndefined()
    expect(
      schemeV13Schema.safeParse({ ...removePlacement(current, 1), schemaVersion: 13 }).success,
    ).toBe(false)
  })
  it('preserves the complete post, branch, independent distances, source, marks and pins', () => {
    const scheme = example(),
      before = structuredClone(scheme),
      excluded = removePlacement(scheme, 1)
    expect(excluded.roadObjectExclusions?.objects).toEqual([
      { post: scheme.placements[0], link: scheme.roadLayout.links[0] },
    ])
    expect(excluded.placements).toEqual(scheme.placements.filter((p) => p.id !== 1))
    expect(excluded.roadLayout.links.some((link) => link.placementId === 1)).toBe(false)
    expect(excluded.signImages).toEqual(scheme.signImages)
    expect(excluded.source).toEqual(scheme.source)
    expect(excluded.reviewMarks).toEqual(scheme.reviewMarks)
    expect(excluded.nextPlacementId).toBe(scheme.nextPlacementId)
    expect(importSchemeJson(exportSchemeJson(excluded)).scheme).toEqual(excluded)
    expect(restoreRoadPlacement(excluded, 1)).toEqual(scheme)
    expect(scheme).toEqual(before)
  })
  it('removes the drawing only, without shifting other posts or road nodes', () => {
    const scheme = example()
    // Make this post the farthest scale input, so dropping it would change other coordinates.
    const post = scheme.placements[0]!
    if (post.kind !== 'sign-post') throw Error('Post expected')
    post.distance = { by: 'metres', approach: 'left', metres: 9000 }
    const excluded = removePlacement(scheme, 1),
      before = schemeLayout(scheme),
      after = schemeLayout(excluded)
    for (const p of excluded.placements) expect(after.coordinates(p)).toEqual(before.coordinates(p))
    const drawing = drawSheet(projectDraftSheet(excluded), options)
    expect(drawing.objectBoxes.some((box) => box.id === 1)).toBe(false)
    expect(projectDraftSheet(excluded).roadSheet).toEqual(projectDraftSheet(scheme).roadSheet)
    expect(roadLayoutProblem(excluded)).toBeTruthy()
  })
  it.each([
    [1, 2],
    [2, 1],
  ])('restores non-ID ordering after multiple exclusions in order %j', (first, second) => {
    const scheme = example()
    scheme.placements = [...scheme.placements].reverse()
    scheme.roadLayout.links = [...scheme.roadLayout.links].reverse()
    const excluded = removePlacement(removePlacement(scheme, 1), 2)
    expect(restoreRoadPlacement(restoreRoadPlacement(excluded, first), second)).toEqual(scheme)
  })
  it('retains existing order when new posts are created and unrelated objects deleted', () => {
    let scheme = example()
    const post = newSignDraft()
    if (post.kind !== 'sign-post') throw Error('Post expected')
    post.signCodes = '1.25'
    scheme = removePlacement(scheme, 1)
    const added = savePlacement(scheme, post),
      restored = restoreRoadPlacement(added, 1)
    expect(restored.placements.at(-1)?.id).toBe(added.nextPlacementId - 1)
    expect(restored.placements[0]?.id).toBe(1)
    expect(
      removePlacement(restored, added.nextPlacementId - 1).roadObjectExclusions,
    ).toBeUndefined()
  })
  it('undoes exclusion and restoration as one action each', () => {
    const scheme = example(),
      excluded = removePlacement(scheme, 1)
    let history = recordEdit(startHistory(scheme), excluded)
    expect(undoEdit(history).present).toEqual(scheme)
    expect(redoEdit(undoEdit(history)).present).toEqual(excluded)
    history = recordEdit(history, restoreRoadPlacement(excluded, 1))
    expect(undoEdit(history).present).toEqual(excluded)
  })
  it('protects a node referenced by an excluded post and incompatible side changes', () => {
    const scheme = removePlacement(example(), 1)
    expect(() => removeRoadNode(scheme, 1)).toThrow('связанные объекты')
    const draft = createRoadNodeDraft(scheme.roadLayout.nodes[0]!)
    draft.side = 'up'
    expect(() => saveRoadNode(scheme, draft)).toThrow('Ветвь стойки')
    draft.side = 'down'
    draft.sheetOffsetXSvg = '-180'
    const edited = saveRoadNode(scheme, draft),
      restored = restoreRoadPlacement(edited, 1)
    expect(restored.roadLayout.links[0]?.branchPlacement).toEqual(
      scheme.roadObjectExclusions?.objects[0]?.link.branchPlacement,
    )
    expect(restored.roadLayout.nodes).toEqual(edited.roadLayout.nodes)
  })
  it('preserves image pins through exclusion, restore and explicit repinning', () => {
    const scheme = example(),
      post = scheme.placements[0]!
    if (post.kind !== 'sign-post') throw Error('Post expected')
    post.signIds = ['9.99']
    const available = [...new Set(usedSignCodes(scheme))].map((code) => ({ code, revision: 2 }))
    const pinned = pinSignImages(
      scheme,
      { id: 1, documentCode: 'Учебный', edition: '2026' },
      available,
    )
    const excluded = clearPinsAfterSignChange(pinned, removePlacement(pinned, 1))
    expect(usedSignCodes(excluded)).not.toContain('9.99')
    expect(excluded.signImages).toEqual(pinned.signImages)
    const repinned = pinSignImages(excluded, pinned.signImages.catalog!, available)
    expect(repinned.signImages.revisions['9.99']).toBe(2)
    expect(
      clearPinsAfterSignChange(repinned, restoreRoadPlacement(repinned, 1)).signImages,
    ).toEqual(repinned.signImages)
  })
  it.each([
    'duplicate',
    'occupied',
    'next-id',
    'wrong-link',
    'missing-node',
    'missing-order',
  ] as const)('rejects inconsistent exclusion: %s', (mode) => {
    const scheme = removePlacement(example(), 1),
      state = scheme.roadObjectExclusions!,
      item = state.objects[0]!
    if (mode === 'duplicate') state.objects.push(structuredClone(item))
    if (mode === 'occupied') scheme.placements.push(item.post)
    if (mode === 'next-id') scheme.nextPlacementId = item.post.id
    if (mode === 'wrong-link') item.link.placementId = 2
    if (mode === 'missing-node')
      scheme.roadLayout.nodes = scheme.roadLayout.nodes.filter((n) => n.id !== 1)
    if (mode === 'missing-order') state.placementOrder = []
    expect(schemeSchema.safeParse(scheme).success).toBe(false)
  })
})
