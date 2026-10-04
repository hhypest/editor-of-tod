import { describe, expect, it } from 'vitest'
import { createUnlinkedScheme, createSchemeFromPu66 } from '../create-scheme'
import { applySchemeDetails, createSchemeDetailsDraft } from '../edit-details'
import { exportSchemeJson, importSchemeJson } from '../import'
import { PROTOTYPE_RULES } from '../normative-parameters'
import { adviseRegulation } from '../regulation-advice'
import { reviewScheme } from '../review-scheme'
import { setMark, markState } from '../review-marks'
import { buildTemplatePlacements } from '../template-placements'
import { savePlacement, newTextDraft } from '../edit-placements'
import { workTrafficDecision, effectiveWorkSection } from '../work-traffic'

const conditions = {
  kind: 'short' as const,
  durationHours: 4.5,
  daylight: 'day' as const,
  regulatorsPresent: true,
  sectionMetres: null,
}
const input = {
  referenceId: 'TEST-CONDITIONS',
  locationText: 'Учебная дорога',
  directionLeft: 'А',
  directionRight: 'Б',
  frontMetres: '21,5',
  taperMetres: '10',
  bufferMetres: '10',
  location: 'out' as const,
  approachSpeedKmh: '90',
  speedStagesKmh: ['70', '50', '40'] as [string, string, string],
  yellowTemporarySigns: false,
  workConditions: conditions,
}
const card = {
  referenceId: 'TEST-PU66',
  location: 'Учебный участок',
  axisLabel: 'Условная ось',
  roadName: 'Учебная дорога',
  crossingWidthMetres: 8,
  crossingRoadLengthMetres: 21.5,
  revision: 1,
  updatedAt: '2026-10-04T00:00:00.000Z',
}
function project() {
  const scheme = createUnlinkedScheme(input)
  scheme.parameters.regulation = {
    ...scheme.parameters.regulation,
    mode: 'two',
    hourly: '300',
    straight: true,
  }
  return scheme
}
describe('explicit conditions after specialist review', () => {
  it('selects B.34 for a 21.5 m front regardless of taper and buffer', () => {
    const scheme = createUnlinkedScheme(input)
    expect(scheme.template.code).toBe('b34')
    expect(effectiveWorkSection(scheme.parameters.workZones.b34, conditions)).toBe(41.5)
    expect(
      createUnlinkedScheme({ ...input, taperMetres: '50', bufferMetres: '50' }).template.code,
    ).toBe('b34')
  })
  it('switches an existing B.33 to B.34, preserves objects and clears acceptance', () => {
    let scheme = createUnlinkedScheme({ ...input, frontMetres: '35' })
    const text = newTextDraft()
    if (text.kind !== 'element') throw new Error('Expected text')
    text.text = 'Учебная ручная надпись'
    scheme = savePlacement(scheme, text)
    scheme = setMark(scheme, reviewScheme(scheme), 'template', true, '2026-10-04T00:00:00.000Z')
    const draft = createSchemeDetailsDraft(scheme)
    draft.parameters.workZones.b33!.workMetres = '21,5'
    const edited = applySchemeDetails(scheme, draft)
    expect(edited.template.code).toBe('b34')
    expect(edited.parameters.workZones.b34?.workMetres).toBe(21.5)
    expect(edited.parameters.workZones.b33).toBeNull()
    expect(edited.placements).toEqual(scheme.placements)
    expect(scheme.placements).toHaveLength(1)
    expect(scheme.reviewMarks.template).toBeDefined()
    expect(edited.reviewMarks).toEqual({})
  })
  it.each([
    [49, 250],
    [49, 500],
    [50, 249],
    [300, 249],
  ])('permits continuously present regulators at %s m / %s veh/h', (section, hourly) => {
    expect(workTrafficDecision(section, hourly, false, PROTOTYPE_RULES, conditions)).toBe(
      'regulators',
    )
    expect(
      adviseRegulation({
        hourly: String(hourly),
        limitedVisibility: false,
        straight: true,
        zoneSpeedKmh: 40,
        taperMetres: 10,
        frontMetres: 21.5,
        sectionMetres: section,
        workConditions: conditions,
      }).mode,
    ).toBe(section >= 50 ? 'two' : hourly < 250 ? 'signs' : 'one')
    const scheme = project()
    scheme.parameters.workConditions.sectionMetres = section
    scheme.parameters.regulation.hourly = String(hourly)
    expect(
      buildTemplatePlacements(scheme).filter(
        (p) => p.kind === 'element' && p.elementKind === 'reg',
      ),
    ).toHaveLength(2)
    expect(reviewScheme(scheme).find((f) => f.id === 'b34-traffic')?.markBlocked).toBeUndefined()
  })
  it.each([
    { ...conditions, regulatorsPresent: false },
    { ...conditions, durationHours: 25 },
    { ...conditions, kind: 'long' as const },
    { ...conditions, durationHours: null },
  ])('blocks replacement when conditions are incomplete: %j', (invalid) => {
    const scheme = project()
    scheme.parameters.workConditions = invalid
    scheme.parameters.workConditions.sectionMetres = 50
    scheme.parameters.regulation.hourly = '249'
    expect(() => buildTemplatePlacements(scheme)).toThrow()
    expect(reviewScheme(scheme).find((f) => f.id === 'work-conditions')?.markBlocked).toBeTruthy()
  })
  it.each([
    [301, 249],
    [49, 501],
    [50, 250],
  ])('retains table exclusions at %s m / %s veh/h', (section, hourly) => {
    expect(workTrafficDecision(section, hourly, false, PROTOTYPE_RULES, conditions)).toBe('outside')
  })
  it('uses measured limits without changing the front or variant', () => {
    const scheme = project()
    scheme.parameters.workConditions.sectionMetres = 50
    expect(
      effectiveWorkSection(scheme.parameters.workZones.b34, scheme.parameters.workConditions),
    ).toBe(50)
    expect(scheme.parameters.workZones.b34?.workMetres).toBe(21.5)
    expect(scheme.template.code).toBe('b34')
  })
  it('rejects measured device limits shorter than the work front', () => {
    const scheme = project()
    scheme.parameters.workConditions.sectionMetres = 20
    expect(() => buildTemplatePlacements(scheme)).toThrow('короче фронта')
    expect(reviewScheme(scheme).find((f) => f.id === 'work-conditions')?.markBlocked).toContain(
      'короче фронта',
    )
  })
  it('rejects one regulator at night; device length does not replace the work front', () => {
    const scheme = project()
    scheme.parameters.regulation.mode = 'one'
    scheme.parameters.workConditions.daylight = 'night'
    expect(() => buildTemplatePlacements(scheme)).toThrow('светлого времени')
    scheme.parameters.workConditions.daylight = 'day'
    scheme.parameters.workConditions.sectionMetres = 50
    scheme.parameters.regulation.hourly = '249'
    expect(
      buildTemplatePlacements(scheme).filter(
        (p) => p.kind === 'element' && p.elementKind === 'reg',
      ),
    ).toHaveLength(1)
    scheme.parameters.regulation.mode = 'two'
    expect(buildTemplatePlacements(scheme).length).toBeGreaterThan(0)
  })
  it('enforces the pinned PU-66 length on creation, editing and review, without limiting taper/buffer', () => {
    const scheme = createSchemeFromPu66(input, card)
    expect(() => createSchemeFromPu66({ ...input, frontMetres: '21.501' }, card)).toThrow('п. 8')
    const draft = createSchemeDetailsDraft(scheme)
    draft.parameters.workZones.b34!.workMetres = '22'
    expect(() => applySchemeDetails(scheme, draft)).toThrow('п. 8')
    scheme.parameters.workZones.b34!.workMetres = 22
    expect(reviewScheme(scheme).find((f) => f.id === 'work-conditions')?.markBlocked).toContain(
      'превышает',
    )
    expect(
      createSchemeFromPu66({ ...input, taperMetres: '100', bufferMetres: '100' }, card).template
        .code,
    ).toBe('b34')
  })
  it('roundtrips v8 and opens v7 without inventing confirmations', () => {
    const scheme = project()
    expect(importSchemeJson(exportSchemeJson(scheme)).scheme).toEqual(scheme)
    const { workConditions: _absent, ...parameters } = scheme.parameters
    void _absent
    const imported = importSchemeJson(JSON.stringify({ ...scheme, schemaVersion: 7, parameters }))
    expect(imported.format).toBe('scheme-v7')
    expect(imported.scheme.schemaVersion).toBe(8)
    expect(imported.scheme.parameters.workConditions.kind).toBe('unknown')
    expect(() => buildTemplatePlacements(imported.scheme)).toThrow('краткосрочные')
  })
  it('requires a new acceptance after duration or regulator presence changes', () => {
    const scheme = project()
    const reviewed = reviewScheme(scheme)
    const marked = setMark(scheme, reviewed, 'work-conditions', true, '2026-10-04T00:00:00.000Z')
    marked.parameters.workConditions.durationHours = 6
    expect(
      markState(
        marked,
        reviewScheme(marked).find((f) => f.id === 'work-conditions')!,
      ).status,
    ).toBe('stale')
  })
})
