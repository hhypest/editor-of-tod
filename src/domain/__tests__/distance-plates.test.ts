import { describe, expect, it } from 'vitest'
import { createUnlinkedScheme } from '../create-scheme'
import { newSignDraft, savePlacement } from '../edit-placements'
import { projectDraftSheet } from '../draft-sheet'
import { exportSchemeJson, importSchemeJson } from '../import'
import { distancePlate, drawableWithoutImage, drawnSignBase } from '../sign-code'
import { pinSignImages } from '../sign-images'
import { drawSheet, type SheetNode } from '../sheet-drawing'

function project() {
  const scheme = createUnlinkedScheme({
    referenceId: 'TEST-PLATES',
    locationText: 'Учебная дорога',
    directionLeft: 'А',
    directionRight: 'Б',
    frontMetres: '18',
    taperMetres: '10',
    bufferMetres: '10',
    location: 'out',
    approachSpeedKmh: '90',
    speedStagesKmh: ['70', '50', '40'],
    yellowTemporarySigns: false,
  })
  const post = newSignDraft()
  if (post.kind !== 'sign-post') throw new Error('Expected sign post')
  post.signCodes = '8.1.3_120, 8.1.4_1234567'
  return savePlacement(scheme, post)
}

describe('directional distance plates', () => {
  it.each([
    ['8.1.1_150', '8.1.1', '150', null],
    ['8.1.3_120', '8.1.3', '120', 'right'],
    ['8.1.4_1234567', '8.1.4', '1234567', 'left'],
  ])('recognizes %s without changing its value', (code, base, value, direction) => {
    expect(distancePlate(code!)).toEqual({ base, value, direction })
    expect(drawnSignBase(code!)).toBe(base)
    expect(drawableWithoutImage(code!)).toBe(true)
  })

  it.each(['8.1.3', '8.1.4#120', '8.1.2_120', '8.1.3_-1', '8.1.4_1.5', '8.1.3_120oops'])(
    'does not invent a drawable distance for %s',
    (code) => {
      expect(distancePlate(code)).toBeNull()
      expect(drawnSignBase(code)).toBeNull()
      expect(drawableWithoutImage(code)).toBe(false)
    },
  )

  it('pins the corresponding base revisions and round-trips both codes', () => {
    const pinned = pinSignImages(project(), { id: 1, documentCode: 'TEST', edition: '2026' }, [
      { code: '8.1.3', revision: 2 },
      { code: '8.1.4', revision: 3 },
    ])
    expect(pinned.signImages.revisions).toEqual({ '8.1.3': 2, '8.1.4': 3 })
    expect(importSchemeJson(exportSchemeJson(pinned)).scheme).toEqual(pinned)
  })

  it('allows a drawn fallback and prefers an exact variant image when present', () => {
    const catalog = { id: 1, documentCode: 'TEST', edition: '2026' }
    expect(pinSignImages(project(), catalog, []).signImages.revisions).toEqual({})
    expect(
      pinSignImages(project(), catalog, [
        { code: '8.1.3', revision: 2 },
        { code: '8.1.3_120', revision: 5 },
      ]).signImages.revisions,
    ).toEqual({ '8.1.3_120': 5 })
  })

  it('uses each base image aspect ratio on the sheet', () => {
    const drawing = drawSheet(projectDraftSheet(project()), {
      signSizes: new Map([
        ['8.1.3', { width: 254, height: 130 }],
        ['8.1.4', { width: 254, height: 132 }],
      ]),
      catalogLabel: 'TEST',
      revisionLabel: '',
    })
    const flatten = (nodes: readonly SheetNode[]): SheetNode[] =>
      nodes.flatMap((node) => (node.t === 'group' ? flatten(node.children) : [node]))
    const signs = flatten(drawing.nodes).filter((node) => node.t === 'sign')
    expect(signs.map((node) => node.code)).toEqual(['8.1.3_120', '8.1.4_1234567'])
    expect(signs[0]!.w / signs[0]!.h).toBeCloseTo(254 / 130)
    expect(signs[1]!.w / signs[1]!.h).toBeCloseTo(254 / 132)
  })
})
