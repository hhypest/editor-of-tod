import { describe, expect, it } from 'vitest'
import { createSchemeFromPu66 } from '../create-scheme'
import {
  applySchemeDetails,
  createSchemeDetailsDraft,
  switchToPartialB34,
  switchToSolidB33,
  templateByRule,
} from '../edit-details'
import { PROTOTYPE_RULES } from '../normative-parameters'
import { workConditionProblems } from '../work-conditions'
import { reviewScheme } from '../review-scheme'
import { buildTemplatePlacements } from '../template-placements'
import { exportSchemeJson, importSchemeJson } from '../import'
import { projectDraftSheet } from '../draft-sheet'
import { detailsDraftSchema } from '../recovery'
import { adviseRegulation } from '../regulation-advice'
import { recordRegulationDecision } from '../decision-evidence'
import { autoRebuildTemplate } from '../template-rebuild'
import { recordEdit, startHistory, undoEdit, redoEdit } from '../edit-history'

const input = {
  locationText: 'Учебное пересечение',
  directionLeft: 'А',
  directionRight: 'Б',
  frontMetres: '24',
  taperMetres: '10',
  bufferMetres: '10',
  location: 'out' as const,
  approachSpeedKmh: '90',
  speedStagesKmh: ['70', '50', '40'] as [string, string, string],
  yellowTemporarySigns: false,
  frontFromPu66: true,
  workConditions: {
    kind: 'short' as const,
    durationHours: 4,
    daylight: 'day' as const,
    regulatorsPresent: true,
    sectionMetres: null,
  },
}
function project(length: number, front = length) {
  const scheme = createSchemeFromPu66(
    { ...input, frontMetres: String(front) },
    {
      referenceId: 'FICTIONAL-FRONT',
      location: 'Учебный переезд',
      axisLabel: 'Условная ось',
      roadName: 'Вымышленная дорога',
      crossingWidthMetres: 6,
      crossingRoadLengthMetres: length,
      revision: 1,
      updatedAt: '2026-10-29T00:00:00.000Z',
    },
  )
  scheme.parameters.regulation = { ...scheme.parameters.regulation, mode: 'two', hourly: '310' }
  return scheme
}

describe('specialist front decisions of 29 October, #103', () => {
  it.each([
    [24, 'b34'],
    [30, 'b34'],
    [30.1, 'b33'],
    [45, 'b33'],
  ] as const)(
    'uses the full PU-66 length %s as a solid %s front, excluding taper and buffer',
    (length, code) => {
      const scheme = project(length)
      expect(scheme.template.code).toBe(code)
      expect(scheme.parameters.frontStyle).toBe('solid')
      expect(scheme.parameters.workZones[code]).toMatchObject({
        workMetres: length,
        taperMetres: 10,
        bufferMetres: 10,
      })
      expect(workConditionProblems(scheme, PROTOTYPE_RULES)).toEqual([])
    },
  )

  it('explicitly selects a long partial B.34, preserves objects, and round-trips the decision', () => {
    const solid = project(38)
    solid.placements = buildTemplatePlacements(solid)
    solid.nextPlacementId = Math.max(...solid.placements.map((p) => p.id)) + 1
    const partial = switchToPartialB34(solid, PROTOTYPE_RULES)
    expect(partial.template.code).toBe('b34')
    expect(partial.parameters.frontStyle).toBe('part')
    expect(partial.parameters.workZones.b34?.workMetres).toBe(38)
    expect(partial.placements).toEqual(solid.placements)
    expect(partial.reviewMarks).toEqual({})
    expect(templateByRule(partial, PROTOTYPE_RULES)).toBeNull()
    expect(reviewScheme(partial).some((f) => f.id === 'variant-front')).toBe(false)
    expect(workConditionProblems(partial, PROTOTYPE_RULES)).toEqual([])
    expect(importSchemeJson(exportSchemeJson(partial)).scheme).toEqual(partial)
    expect(applySchemeDetails(partial, createSchemeDetailsDraft(partial)).template.code).toBe('b34')
    expect(projectDraftSheet(partial).frontStyle).toBe('part')
    expect(solid.template.code).toBe('b33')
    const rebuilt = autoRebuildTemplate(solid, partial, PROTOTYPE_RULES)
    expect(rebuilt.kind).toBe('rebuilt')
    if (rebuilt.kind !== 'rebuilt') throw new Error('Expected template rebuild')
    expect(
      rebuilt.scheme.placements.filter((p) => p.kind === 'element' && p.elementKind === 'pit'),
    ).toHaveLength(4)
    const history = recordEdit(startHistory(solid), rebuilt.scheme)
    expect(undoEdit(history).present).toBe(solid)
    expect(redoEdit(undoEdit(history)).present).toEqual(rebuilt.scheme)
    const back = switchToSolidB33(rebuilt.scheme, PROTOTYPE_RULES)
    expect(back.template.code).toBe('b33')
    expect(back.parameters.frontStyle).toBe('solid')
  })

  it('rejects making the long partial B.34 solid, including imported invalid projects', () => {
    const partial = switchToPartialB34(project(38), PROTOTYPE_RULES)
    const draft = createSchemeDetailsDraft(partial)
    draft.parameters.frontStyle = 'solid'
    draft.parameters.frontFromPu66 = false
    expect(() => applySchemeDetails(partial, draft)).toThrow('Сплошной фронт Б.34')
    const invalid = structuredClone(partial)
    invalid.parameters.frontStyle = 'solid'
    const reopened = importSchemeJson(exportSchemeJson(invalid)).scheme
    expect(reopened.parameters.frontStyle).toBe('solid')
    expect(workConditionProblems(reopened, PROTOTYPE_RULES).join(' ')).toContain(
      'Сплошной фронт Б.34',
    )
    expect(() => buildTemplatePlacements(reopened)).toThrow('Сплошной фронт Б.34')
    expect(reviewScheme(reopened).find((f) => f.id === 'work-conditions')?.markBlocked).toBeTruthy()
  })

  it('reapplies PU-66 as a solid B.33 even if the long partial front length is unchanged', () => {
    const partial = switchToPartialB34(project(38), PROTOTYPE_RULES)
    const draft = createSchemeDetailsDraft(partial)
    draft.parameters.frontStyle = 'solid'
    draft.parameters.frontFromPu66 = true
    draft.pu66FrontRequested = true
    const recovered = detailsDraftSchema.parse(draft)
    const updated = applySchemeDetails(partial, recovered)
    expect(updated.template.code).toBe('b33')
    expect(updated.parameters.frontStyle).toBe('solid')
    expect(updated.parameters.workZones.b33?.workMetres).toBe(38)
    expect(updated).not.toHaveProperty('pu66FrontRequested')
    // Даже прежний недопустимый сплошной Б.34 исправляется повторной подстановкой той же длины.
    const invalid = structuredClone(partial)
    invalid.parameters.frontStyle = 'solid'
    const same = createSchemeDetailsDraft(invalid)
    expect(() => applySchemeDetails(invalid, same)).toThrow('Сплошной фронт Б.34')
    same.pu66FrontRequested = true
    expect(applySchemeDetails(invalid, same).template.code).toBe('b33')
  })

  it('blocks an excessive front at creation and after reopening, and permits correction', () => {
    expect(() => project(46)).toThrow('45 м')
    const scheme = project(45)
    scheme.parameters.workZones.b33!.workMetres = 46
    const reopened = importSchemeJson(exportSchemeJson(scheme)).scheme
    expect(reopened.parameters.workZones.b33?.workMetres).toBe(46)
    expect(switchToPartialB34(reopened, PROTOTYPE_RULES)).toBe(reopened)
    const draft = createSchemeDetailsDraft(reopened)
    expect(() => applySchemeDetails(reopened, draft)).toThrow('45 м')
    expect(() => buildTemplatePlacements(reopened)).toThrow('45 м')
    draft.parameters.workZones.b33!.workMetres = '44'
    const fixed = applySchemeDetails(reopened, draft)
    expect(fixed.parameters.frontFromPu66).toBe(false)
    expect(fixed.parameters.workZones.b33?.workMetres).toBe(44)
  })

  it('uses configured thresholds and the pinned card instead of hard-coded limits', () => {
    const scheme = project(38)
    const strict = { ...PROTOTYPE_RULES, frontLimitMetres: 35 }
    expect(switchToPartialB34(scheme, strict)).toBe(scheme)
    const short = project(24)
    const changed = { ...PROTOTYPE_RULES, b34MaxFrontMetres: 20 }
    expect(workConditionProblems(short, changed).join(' ')).toContain('20 м')
    expect(() => project(24, 25)).toThrow('24 м')
    const draft = createSchemeDetailsDraft(short)
    draft.parameters.workZones.b34!.workMetres = '25'
    expect(() => applySchemeDetails(short, draft)).toThrow('24 м')
  })

  it('uses the explicitly selected partial B.34 for advice and recorded recommendations', () => {
    const partial = switchToPartialB34(project(38), PROTOTYPE_RULES)
    partial.parameters.workConditions.sectionMetres = 48
    partial.parameters.regulation.hourly = '180'
    const decision = recordRegulationDecision(partial, PROTOTYPE_RULES, 'Учебная проверка')
    expect(decision.decisionEvidence.regulation?.input.variant).toBe('b34')
    expect(decision.decisionEvidence.regulation?.recommendation).toBe('signs')
    const solid = switchToSolidB33(partial, PROTOTYPE_RULES)
    expect(
      recordRegulationDecision(solid, PROTOTYPE_RULES, 'Учебная проверка').decisionEvidence
        .regulation?.recommendation,
    ).toBe('two')
    expect(
      adviseRegulation({
        hourly: '180',
        limitedVisibility: false,
        straight: true,
        zoneSpeedKmh: 40,
        taperMetres: 15,
        frontMetres: 38,
        sectionMetres: 48,
        workConditions: input.workConditions,
        variant: 'b34',
      }).mode,
    ).toBe('signs')
  })
})
