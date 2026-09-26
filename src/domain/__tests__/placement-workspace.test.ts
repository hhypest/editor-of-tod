import { describe, expect, it } from 'vitest'
import b33 from '../../../tests/fixtures/manual-v1.json?raw'
import b34 from '../../../tests/fixtures/legacy-b34-manual.json?raw'
import { exportSchemeJson, importSchemeJson } from '../import'
import { anchorCoordinates, movePlacement, placementCoordinates } from '../placement-workspace'

const scheme33 = importSchemeJson(b33).scheme
const scheme34 = importSchemeJson(b34).scheme

describe('coordinate workspace for imported objects', () => {
  it('resolves anchors using the selected work zone and keeps element Y absolute', () => {
    const anchors33 = anchorCoordinates(scheme33)
    expect(anchors33).toMatchObject({ L0: 540, L1: 603, Z0: 738, Z1: 1071, E: 1134 })
    const post = scheme33.placements[0]!
    expect(placementCoordinates(post, anchors33)).toEqual({ x: 20, y: 579 })
    const text = scheme33.placements[1]!
    expect(placementCoordinates(text, anchors33)).toEqual({ x: 810, y: 605 })

    const anchors34 = anchorCoordinates(scheme34)
    expect(anchors34.E).toBe(anchors34.Z1)
    expect(anchors34.AX).toBe((anchors34.Z0 + anchors34.Z1) / 2)
    expect(placementCoordinates(scheme34.placements[0]!, anchors34)).toEqual({ x: 755, y: 323 })
    expect(placementCoordinates(scheme34.placements[2]!, anchors34).y).toBe(600)
  })

  it('moves an anchored post and an element without changing their anchor, contents or source', () => {
    const movedPost = movePlacement(scheme34, 4, -11, 7)
    expect(movedPost.placements[0]).toMatchObject({
      kind: 'sign-post',
      generatedByTemplate: false,
      position: { anchor: 'L1', offsetXSvg: 114, offsetYSvg: -23 },
    })
    expect(
      movedPost.placements[0]?.kind === 'sign-post' && movedPost.placements[0].signIds,
    ).toEqual(['1.25'])
    const movedCone = movePlacement(movedPost, 11, 3, -5)
    expect(movedCone.placements.at(-1)).toMatchObject({
      kind: 'element',
      elementKind: 'cone',
      generatedByTemplate: false,
      position: { anchor: 'AX', offsetXSvg: 26, ySvg: 15 },
      sizeSvg: { width: 12, height: 12 },
    })
    expect(movedCone.placements.slice(1, 3)).toEqual(scheme34.placements.slice(1, 3))
    expect(movedCone.source).toMatchObject({ originalJson: b34 })
    expect(scheme34.placements[0]?.generatedByTemplate).toBe(true)
    expect(importSchemeJson(exportSchemeJson(movedCone)).scheme).toEqual(movedCone)
  })

  it('does not record a zero movement or accept an unknown object or invalid delta', () => {
    expect(movePlacement(scheme33, 1, 0, 0)).toBe(scheme33)
    expect(() => movePlacement(scheme33, 999, 1, 0)).toThrow('не найден')
    expect(() => movePlacement(scheme33, 1, Number.NaN, 0)).toThrow('конечным числом')
  })
})
