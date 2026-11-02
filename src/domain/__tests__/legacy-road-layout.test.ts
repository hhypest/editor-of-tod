import legacyFixture from '../../../tests/fixtures/manual-v1.json?raw'
import { describe, expect, it } from 'vitest'
import { legacyV1Schema, type LegacyV1 } from '../legacy-v1'
import {
  importSchemeJson,
  exportSchemeJson,
  SchemeImportError,
  storedFormatWarnings,
} from '../import'
import { schemeSchema, type Scheme } from '../model'
import { LEGACY_ROAD_LAYOUT_PROBLEM, legacyRoadLayoutProblem } from '../legacy-road-layout'
import {
  buildTemplatePlacements,
  rebuildTemplatePlacements,
  TemplateBuildError,
} from '../template-placements'
import { autoRebuildTemplate } from '../template-rebuild'
import { releaseProblems } from '../release-readiness'
import { reviewScheme } from '../review-scheme'
import { PROTOTYPE_RULES } from '../normative-parameters'

function example(): LegacyV1 {
  const base = legacyV1Schema.parse(JSON.parse(legacyFixture))
  base.params.variant = 'b34'
  base.params.loc = 'out'
  base.params.front = 'solid'
  base.params.len.b34.zone = 18
  base.params.junc = [
    { id: 7, app: 'L', edge: 'down', d: 125, kind: 'road', name: 'Учебная ветвь', side: true },
  ]
  base.params.tee = { on: false }
  base.objects.push(
    {
      t: 'post',
      id: 1001,
      signs: ['1.25', '8.1.1#115'],
      anchor: 'L0',
      dx: -280,
      dy: 3,
      side: 'down',
      stand: 'left',
      dist: null,
      auto: 1,
      jrep: 7,
    },
    {
      t: 'post',
      id: 1002,
      signs: ['1.25', '8.1.3#125'],
      anchor: 'L0',
      dx: -360,
      dy: 22,
      side: 'up',
      stand: 'left',
      dist: null,
      auto: 1,
      jside: 7,
      vert: 1,
      sc: 0.8,
    },
  )
  base.nid = 2000
  return base
}

function imported(value = example()) {
  const original = JSON.stringify(value)
  return {
    original,
    result: importSchemeJson(original, {
      id: '00000000-0000-4000-8000-000000000007',
      now: '2026-11-01T00:00:00.000Z',
    }),
  }
}

function ready(scheme: Scheme): Scheme {
  return schemeSchema.parse({
    ...scheme,
    parameters: {
      ...scheme.parameters,
      location: 'out',
      signSize: 'II',
      approachSpeedKmh: 90,
      workConditions: {
        kind: 'short',
        durationHours: 4,
        daylight: 'day',
        regulatorsPresent: true,
        sectionMetres: null,
      },
      regulation: { ...scheme.parameters.regulation, mode: 'two', hourly: '350' },
    },
  })
}

describe('legacy road layouts: preservation before P6', () => {
  it('keeps related posts manual, preserves coordinates and raw source, and separates plate codes/values', () => {
    const { original, result } = imported()
    const posts = result.scheme.placements.filter((p) => p.id >= 1001)
    expect(posts).toMatchObject([
      {
        id: 1001,
        generatedByTemplate: false,
        position: { anchor: 'L0', offsetXSvg: -280, offsetYSvg: 3 },
        signIds: ['1.25', '8.1.1_115'],
        distance: null,
      },
      {
        id: 1002,
        generatedByTemplate: false,
        position: { anchor: 'L0', offsetXSvg: -360, offsetYSvg: 22 },
        signIds: ['1.25', '8.1.3_125'],
        distance: null,
      },
    ])
    expect(result.scheme.source).toMatchObject({ originalJson: original })
    expect(result.warnings).toContain(LEGACY_ROAD_LAYOUT_PROBLEM)
    expect(
      result.warnings.some((w) => /Неизвестное поле .*?(junc|tee|jrep|jside|vert|sc)/.test(w)),
    ).toBe(false)
  })

  it('retains protection and manual objects through current export/import', () => {
    const first = imported().result.scheme
    const reopened = importSchemeJson(exportSchemeJson(first)).scheme
    expect(reopened).toEqual(first)
    expect(reopened.schemaVersion).toBe(13)
    expect(importSchemeJson(exportSchemeJson(first)).warnings).toContain(LEGACY_ROAD_LAYOUT_PROBLEM)
    expect(storedFormatWarnings(11, reopened)).toContain(LEGACY_ROAD_LAYOUT_PROBLEM)
    expect(legacyRoadLayoutProblem(reopened.source)).toBe(LEGACY_ROAD_LAYOUT_PROBLEM)
  })

  it('does not delete or replace objects on either explicit rebuilding entry point', () => {
    const scheme = ready(imported().result.scheme)
    const before = structuredClone(scheme)
    for (const build of [buildTemplatePlacements, rebuildTemplatePlacements])
      expect(() => build(scheme, PROTOTYPE_RULES)).toThrow(TemplateBuildError)
    expect(scheme).toEqual(before)
  })

  it('also protects previously stored v11 projects whose related objects are still marked automatic', () => {
    const first = imported().result.scheme
    const old = schemeSchema.parse({
      ...first,
      placements: first.placements.map((p) =>
        p.id >= 1001 ? { ...p, generatedByTemplate: true } : p,
      ),
    })
    const { roadLayout: _roadLayout, ...v11 } = old
    void _roadLayout
    const reopened = ready(importSchemeJson(JSON.stringify({ ...v11, schemaVersion: 11 })).scheme)
    expect(() => rebuildTemplatePlacements(reopened)).toThrow(LEGACY_ROAD_LAYOUT_PROBLEM)
    expect(
      reopened.placements.filter((p) => p.id >= 1001).every((p) => p.generatedByTemplate),
    ).toBe(true)
  })

  it('keeps the applied document and objects when automatic rebuilding cannot support the road layout', () => {
    const previous = ready(imported().result.scheme)
    const next = schemeSchema.parse({
      ...previous,
      parameters: {
        ...previous.parameters,
        workZones: {
          ...previous.parameters.workZones,
          b34: { ...previous.parameters.workZones.b34!, bufferMetres: 12 },
        },
      },
    })
    const result = autoRebuildTemplate(previous, next, PROTOTYPE_RULES)
    expect(result.kind).toBe('failed')
    if (result.kind === 'failed') expect(result.message).toContain(LEGACY_ROAD_LAYOUT_PROBLEM)
    expect(next.placements).toEqual(previous.placements)
    expect(next.parameters.workZones.b34?.bufferMetres).toBe(12)
  })

  it('blocks release independently of manual review marks', () => {
    const scheme = ready(imported().result.scheme)
    expect(releaseProblems(scheme)).toContain(LEGACY_ROAD_LAYOUT_PROBLEM)
    expect(reviewScheme(scheme)).toContainEqual(
      expect.objectContaining({
        id: 'legacy-road-layout',
        kind: 'fill',
        path: 'source.originalJson',
      }),
    )
  })

  it('does not attach an embedded PU-66 card or add it to the local registry', () => {
    const value = example()
    value.pu66 = { secretField: 'SYNTHETIC-ONLY', source: 'producer' }
    const { original, result } = imported(value)
    expect(result.scheme.crossing).toMatchObject({ source: 'legacy-pu66', snapshot: null })
    expect(result.scheme.source).toMatchObject({ originalJson: original })
    expect(result.warnings.some((w) => w.includes('Карточка ПУ-66 из прежнего файла'))).toBe(true)
    expect(result.warnings.some((w) => w.includes('Неизвестное поле pu66'))).toBe(false)
  })

  it('leaves ordinary projects with empty junc and disabled tee rebuildable, without extension warnings', () => {
    const value = example()
    value.params.junc = []
    value.params.tee = { on: false }
    value.objects = value.objects.filter((o) => o.id < 1001)
    const { result } = imported(value)
    expect(legacyRoadLayoutProblem(result.scheme.source)).toBeNull()
    expect(result.warnings.some((w) => /Неизвестное поле params\.(junc|tee)/.test(w))).toBe(false)
    expect(() => rebuildTemplatePlacements(ready(result.scheme))).not.toThrow()
  })

  it('recognizes orphaned road metadata even when params no longer contains a junction', () => {
    const value = example()
    value.params.junc = []
    const { result } = imported(value)
    expect(result.scheme.placements.find((p) => p.id === 1001)?.generatedByTemplate).toBe(false)
    expect(legacyRoadLayoutProblem(result.scheme.source)).toBe(LEGACY_ROAD_LAYOUT_PROBLEM)
  })

  it('protects active tee and its elements on either approach', () => {
    for (const app of ['L', 'R'] as const) {
      const value = example()
      value.params.junc = []
      value.params.tee = { on: true, app, d: 85, n1: 'Учебная ветвь Б', n2: 'Учебная ветвь В' }
      value.objects = value.objects.filter((o) => o.id < 1001)
      value.objects.push({
        t: 'el',
        id: 1003,
        e: 'text',
        anchor: 'abs',
        dx: 400,
        y: 200,
        w: 0,
        h: 0,
        text: 'Учебная ветвь',
        auto: 1,
        tee: 1,
      })
      const { result } = imported(value)
      expect(result.scheme.placements.find((p) => p.id === 1003)?.generatedByTemplate).toBe(false)
      expect(legacyRoadLayoutProblem(result.scheme.source)).toBe(LEGACY_ROAD_LAYOUT_PROBLEM)
    }
  })

  it.each([
    [
      'params.junc.0.d',
      (v: LegacyV1) => {
        ;(v.params.junc as Array<{ d: number }>)[0]!.d = -1
      },
    ],
    [
      'params.tee.d',
      (v: LegacyV1) => {
        v.params.tee = { on: true, app: 'R', d: 'wrong', n1: '', n2: '' }
      },
    ],
    [
      'road object jrep',
      (v: LegacyV1) => {
        v.objects.find((o) => o.id === 1001)!.jrep = -2
      },
    ],
  ])('rejects malformed known extension at %s without partial import', (field, change) => {
    const value = example()
    // Locate related objects by stable ID instead of assuming a fixture array index.
    const firstRoad = value.objects.findIndex((o) => o.id === 1001)
    change(value)
    expect(() => imported(value)).toThrow(SchemeImportError)
    try {
      imported(value)
    } catch (error) {
      expect(error).toMatchObject({
        code: 'invalid-data',
        field: field === 'road object jrep' ? 'objects.' + firstRoad + '.jrep' : field,
      })
    }
  })

  it('does not interpret unknown or malformed plate suffixes as a supported value', () => {
    const value = example()
    const post = value.objects.find((o) => o.id === 1001)!
    if (post.t !== 'post') throw new Error('fixture')
    post.signs = ['8.1.4#85', '8.1.3#bad', '8.1.2#85']
    const placement = imported(value).result.scheme.placements.find((p) => p.id === 1001)
    expect(placement).toMatchObject({ signIds: ['8.1.4_85', '8.1.3#bad', '8.1.2#85'] })
  })

  it('does not reuse a cached result after the same source object receives another original JSON', () => {
    const source = {
      kind: 'legacy-html-v1',
      originalJson: JSON.stringify({ v: 1, params: { junc: [], tee: { on: false } } }),
    }
    expect(legacyRoadLayoutProblem(source)).toBeNull()
    source.originalJson = JSON.stringify({ v: 1, params: { junc: [{ id: 7 }] } })
    expect(legacyRoadLayoutProblem(source)).toBe(LEGACY_ROAD_LAYOUT_PROBLEM)
  })
})
