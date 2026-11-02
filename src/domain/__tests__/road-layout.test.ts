import { describe, expect, it } from 'vitest'
import { legacyRoadFixture as roadFixture } from '../../../tests/fixtures/road-layout'
import raw from '../../../tests/fixtures/manual-v1.json?raw'
import { importSchemeJson, exportSchemeJson, SchemeImportError } from '../import'
import { schemeSchema, schemeV11Schema, parseStoredScheme, upgradeSchemeV11 } from '../model'
import { roadLayoutSchema } from '../road-layout'
import { ROAD_LAYOUT_PROBLEM } from '../road-layout-readiness'
import { LEGACY_ROAD_LAYOUT_PROBLEM } from '../legacy-road-layout'
import { removePlacement } from '../edit-placements'
import { startHistory, recordEdit, undoEdit, redoEdit } from '../edit-history'
import { buildTemplatePlacements, rebuildTemplatePlacements } from '../template-placements'
import { releaseProblems } from '../release-readiness'
import { reviewScheme } from '../review-scheme'

const legacyRoadFixture = () => roadFixture(JSON.parse(raw))
const imported = () => importSchemeJson(JSON.stringify(legacyRoadFixture())).scheme

function historical() {
  const { roadLayout: _roadLayout, ...previous } = imported()
  void _roadLayout
  return schemeV11Schema.parse({ ...previous, schemaVersion: 11 })
}

describe('v12 road layout model and compatible import', () => {
  it('separates nodes, drawing offsets and historical links without guessing installation distances', () => {
    const scheme = imported()
    expect(scheme.schemaVersion).toBe(13)
    expect(scheme.roadLayout).toEqual({
      nextNodeId: 11,
      nodes: [
        {
          id: 7,
          kind: 'junction',
          origin: 'legacy-v1',
          position: { approach: 'left', from: 'L0', metres: 120 },
          sheetOffsetXSvg: -211,
          side: 'down',
          roadKind: 'road',
          name: 'Учебная ветвь Альфа',
          sideWarningRequested: true,
        },
        {
          id: 9,
          kind: 'junction',
          origin: 'legacy-v1',
          position: { approach: 'right', from: 'E', metres: 100 },
          sheetOffsetXSvg: 999,
          side: 'up',
          roadKind: 'yard',
          name: 'Учебный выезд Бета',
          sideWarningRequested: false,
        },
        {
          id: 10,
          kind: 'terminal-tee',
          origin: 'legacy-v1',
          position: { approach: 'right', from: 'E', metres: 300 },
          sheetOffsetXSvg: 12,
          branchNames: { up: 'Учебная ветвь Север', down: 'Учебная ветвь Юг' },
        },
      ],
      links: [
        {
          placementId: 1001,
          nodeId: 7,
          role: 'main-repeat',
          origin: 'legacy-v1',
          installation: null,
        },
        {
          placementId: 1002,
          nodeId: 7,
          role: 'side-warning',
          origin: 'legacy-v1',
          installation: null,
        },
        {
          placementId: 1003,
          nodeId: 10,
          role: 'tee-branch',
          origin: 'legacy-v1',
          installation: null,
        },
      ],
    })
    expect(importSchemeJson(exportSchemeJson(scheme))).toMatchObject({
      format: 'scheme-v13',
      scheme,
    })
    expect(scheme.source).toMatchObject({ originalJson: JSON.stringify(legacyRoadFixture()) })
    expect(scheme.placements.find((item) => item.id === 1002)).toMatchObject({
      signIds: ['1.25', '8.1.3_120'],
      generatedByTemplate: false,
    })
  })

  it.each([
    ['L', 'left', 'L0'],
    ['R', 'right', 'E'],
  ] as const)('preserves both sides on approach %s', (app, approach, from) => {
    for (const edge of ['up', 'down'] as const) {
      const legacy = legacyRoadFixture()
      ;(legacy.params.junc as Array<Record<string, unknown>>)[0] = {
        id: 7,
        app,
        edge,
        d: 0,
        kind: 'road',
        name: '',
        side: false,
      }
      const node = importSchemeJson(JSON.stringify(legacy)).scheme.roadLayout.nodes[0]!
      expect(node).toMatchObject({
        side: edge,
        position: { approach, from, metres: 0 },
        sheetOffsetXSvg: null,
      })
    }
  })

  it('stores node distance 120, post installation 50 and plate 120 independently', () => {
    const scheme = imported()
    scheme.roadLayout.links[1]!.installation = { from: 'L0', metres: 50 }
    const reopened = importSchemeJson(exportSchemeJson(scheme)).scheme
    expect(reopened.roadLayout.nodes[0]!.position.metres).toBe(120)
    expect(reopened.roadLayout.links[1]!.installation).toEqual({ from: 'L0', metres: 50 })
    expect(reopened.placements.find((item) => item.id === 1002)).toMatchObject({
      signIds: ['1.25', '8.1.3_120'],
    })
  })

  it('upgrades v11 without changing edited objects, marks, images, evidence, snapshots or raw source', () => {
    const previous = historical()
    previous.placements = previous.placements.filter((item) => item.id !== 1001)
    const post = previous.placements.find((item) => item.id === 1002)!
    if (post.kind !== 'sign-post') throw new Error('Expected post')
    post.position.offsetXSvg = -777
    post.signIds = ['1.25', '8.1.4_125']
    post.generatedByTemplate = true
    const original = structuredClone(previous)
    const scheme = upgradeSchemeV11(previous)
    expect(previous).toEqual(original)
    const { roadLayout, ...rest } = scheme
    expect(rest).toEqual({ ...previous, schemaVersion: 13 })
    expect(roadLayout.links.map((link) => link.placementId)).toEqual([1002, 1003])
    expect(importSchemeJson(JSON.stringify(previous))).toMatchObject({
      format: 'scheme-v11',
      scheme,
    })
    expect(parseStoredScheme(previous)).toEqual(scheme)
    expect(importSchemeJson(exportSchemeJson(scheme)).scheme).toEqual(scheme)
  })

  it('does not silently repair malformed old extensions or invent ambiguous ownership', () => {
    const previous = historical()
    const legacy = legacyRoadFixture()
    legacy.objects.find((item) => item.id === 1002)!.jrep = 9
    legacy.objects.find((item) => item.id === 1001)!.jrep = 555
    previous.source = {
      kind: 'legacy-html-v1',
      importedAt: previous.createdAt,
      originalJson: JSON.stringify(legacy),
    }
    const scheme = upgradeSchemeV11(previous)
    expect(scheme.roadLayout.links.map((link) => link.placementId)).toEqual([1003])
    expect(scheme.placements).toEqual(previous.placements)
    ;(legacy.params.junc as Array<Record<string, unknown>>)[0]!.d = -1
    previous.source.originalJson = JSON.stringify(legacy)
    expect(upgradeSchemeV11(previous).roadLayout).toEqual({ nextNodeId: 1, nodes: [], links: [] })
    expect(releaseProblems(upgradeSchemeV11(previous))).toContain(LEGACY_ROAD_LAYOUT_PROBLEM)
  })

  it('rejects duplicate producer IDs at their source field', () => {
    const legacy = legacyRoadFixture()
    ;(legacy.params.junc as Array<Record<string, unknown>>)[1]!.id = 7
    expect(() => importSchemeJson(JSON.stringify(legacy))).toThrow(SchemeImportError)
    try {
      importSchemeJson(JSON.stringify(legacy))
    } catch (error) {
      expect(error).toMatchObject({ field: 'params.junc.1.id' })
    }
  })

  it('keeps links consistent when deleting a post and restores the complete edit in one undo', () => {
    const scheme = imported()
    const removed = removePlacement(scheme, 1002)
    expect(removed.roadLayout.nodes).toEqual(scheme.roadLayout.nodes)
    expect(removed.roadLayout.links.map((link) => link.placementId)).toEqual([1001, 1003])
    expect(schemeSchema.parse(removed)).toEqual(removed)
    const history = recordEdit(startHistory(scheme), removed)
    expect(undoEdit(history).present).toEqual(scheme)
    expect(redoEdit(undoEdit(history)).present).toEqual(removed)
    expect(importSchemeJson(exportSchemeJson(removed)).scheme).toEqual(removed)
  })

  it('also guards native v12 nodes without legacy source from destructive rebuilding and release', () => {
    const scheme = schemeSchema.parse({ ...imported(), source: { kind: 'created-in-editor' } })
    expect(releaseProblems(scheme)).toContain(ROAD_LAYOUT_PROBLEM)
    expect(() => buildTemplatePlacements(scheme)).toThrow(ROAD_LAYOUT_PROBLEM)
    expect(() => rebuildTemplatePlacements(scheme)).toThrow(ROAD_LAYOUT_PROBLEM)
    expect(reviewScheme(scheme)).toContainEqual(
      expect.objectContaining({ id: 'road-layout', kind: 'fill', path: 'roadLayout.nodes' }),
    )
  })

  it.each([
    [
      'duplicate node',
      (s: ReturnType<typeof imported>) => {
        s.roadLayout.nodes[1]!.id = 7
      },
    ],
    [
      'occupied next ID',
      (s: ReturnType<typeof imported>) => {
        s.roadLayout.nextNodeId = 10
      },
    ],
    [
      'dangling node',
      (s: ReturnType<typeof imported>) => {
        s.roadLayout.links[0]!.nodeId = 555
      },
    ],
    [
      'dangling placement',
      (s: ReturnType<typeof imported>) => {
        s.roadLayout.links[0]!.placementId = 555
      },
    ],
    [
      'duplicate owner',
      (s: ReturnType<typeof imported>) => {
        s.roadLayout.links.push({ ...s.roadLayout.links[0]! })
      },
    ],
    [
      'wrong role',
      (s: ReturnType<typeof imported>) => {
        s.roadLayout.links[0]!.role = 'tee-branch'
      },
    ],
    [
      'negative distance',
      (s: ReturnType<typeof imported>) => {
        s.roadLayout.nodes[0]!.position.metres = -1
      },
    ],
    [
      'nonfinite distance',
      (s: ReturnType<typeof imported>) => {
        s.roadLayout.nodes[0]!.position.metres = Infinity
      },
    ],
    [
      'second terminus',
      (s: ReturnType<typeof imported>) => {
        s.roadLayout.nodes.push({ ...s.roadLayout.nodes[2]!, id: 11 })
        s.roadLayout.nextNodeId = 12
      },
    ],
  ])('rejects %s on the project boundary', (_name, change) => {
    const scheme = imported()
    change(scheme)
    expect(schemeSchema.safeParse(scheme).success).toBe(false)
  })

  it('rejects mismatched approach/reference and requires the explicit v12 field', () => {
    const scheme = imported()
    const layout = JSON.parse(JSON.stringify(scheme.roadLayout))
    layout.nodes[0].position.from = 'E'
    expect(roadLayoutSchema.safeParse(layout).success).toBe(false)
    const { roadLayout: _layout, ...incomplete } = scheme
    void _layout
    expect(schemeSchema.safeParse(incomplete).success).toBe(false)
    expect(schemeV11Schema.safeParse(scheme).success).toBe(false)
  })
})
