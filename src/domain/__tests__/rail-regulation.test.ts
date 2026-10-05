import { describe, expect, it } from 'vitest'
import { createSchemeFromPu66 } from '../create-scheme'
import { applySchemeDetails, createSchemeDetailsDraft } from '../edit-details'
import { exportSchemeJson, importSchemeJson } from '../import'
import {
  parameterDefinition,
  PROTOTYPE_RULES,
  rulesFrom,
  REGULATION_PARAMETERS,
  type ParameterState,
} from '../normative-parameters'
import { railRegulationMode } from '../rail-regulation'
import { adviseRegulation } from '../regulation-advice'
import { reviewScheme } from '../review-scheme'
import { setMark, markState } from '../review-marks'
import { rebuildTemplatePlacements } from '../template-placements'
import { workTrafficDecision } from '../work-traffic'

const conditions = {
  kind: 'short' as const,
  durationHours: 4,
  daylight: 'day' as const,
  regulatorsPresent: true,
  sectionMetres: null,
}
const base = {
  frontMetres: 21.5,
  sectionMetres: 41.5,
  hourly: 298,
  limitedVisibility: false,
  straight: true,
  daylight: 'day' as const,
}
function project(front = 21.5, hourly = '298') {
  const scheme = createSchemeFromPu66(
    {
      locationText: 'Учебная дорога',
      directionLeft: 'А',
      directionRight: 'Б',
      frontMetres: String(front),
      taperMetres: '10',
      bufferMetres: '10',
      location: 'out',
      approachSpeedKmh: '90',
      speedStagesKmh: ['70', '50', '40'],
      yellowTemporarySigns: true,
      workConditions: conditions,
    },
    {
      referenceId: 'TEST-RAIL',
      location: 'Учебный участок',
      axisLabel: 'Условная ось',
      roadName: 'Учебная дорога',
      crossingWidthMetres: 7.5,
      crossingRoadLengthMetres: 45,
      revision: 1,
      updatedAt: '2030-01-01T00:00:00.000Z',
    },
  )
  scheme.parameters.regulation = {
    ...scheme.parameters.regulation,
    hourly,
    mode: 'two',
    straight: true,
  }
  return scheme
}
describe('railway-crossing regulation after normative acceptance', () => {
  it.each([30, 45])('advice anticipates B.33 after a front edit to %s m', (frontMetres) => {
    expect(
      adviseRegulation({
        ...base,
        frontMetres,
        hourly: '180',
        zoneSpeedKmh: 40,
        taperMetres: 10,
        sectionMetres: 75,
        workConditions: conditions,
      }).mode,
    ).toBe('two')
  })
  it.each([
    [0, 'signs'],
    [249, 'signs'],
    [250, 'one'],
    [250.1, 'one'],
    [251, 'one'],
    [298, 'one'],
    [500, 'one'],
    [500.1, 'two'],
    [501, 'two'],
    [915, 'two'],
  ] as const)('normal visibility: %s → %s', (hourly, mode) => {
    expect(railRegulationMode({ ...base, hourly }, PROTOTYPE_RULES)).toBe(mode)
    expect(
      adviseRegulation({
        ...base,
        hourly: String(hourly),
        zoneSpeedKmh: 40,
        taperMetres: 10,
        sectionMetres: 41.5,
        workConditions: conditions,
      }).mode,
    ).toBe(mode)
  })
  it.each([0, 249, 250, 251, 500, 501, 915])(
    'limited visibility and B.33 always give two at %s',
    (hourly) => {
      expect(
        railRegulationMode({ ...base, hourly, limitedVisibility: true }, PROTOTYPE_RULES),
      ).toBe('two')
      expect(
        railRegulationMode({ ...base, frontMetres: 35, hourly, variant: 'b33' }, PROTOTYPE_RULES),
      ).toBe('two')
    },
  )
  it('does not give one when daylight or straight visibility is absent', () => {
    expect(railRegulationMode({ ...base, daylight: 'night' }, PROTOTYPE_RULES)).toBe('two')
    expect(railRegulationMode({ ...base, daylight: 'unknown' }, PROTOTYPE_RULES)).toBe('two')
    expect(railRegulationMode({ ...base, straight: false }, PROTOTYPE_RULES)).toBe('two')
  })
  it('reproduces the high-flow short front and the one-regulator case with synthetic data', () => {
    const high = project(22.6, '915')
    high.parameters.regulation.vis = true
    high.parameters.regulation.straight = false
    high.parameters.workConditions.sectionMetres = 42.6
    const builtHigh = rebuildTemplatePlacements(high).scheme
    const count = (scheme: typeof high) =>
      scheme.placements.filter((p) => p.kind === 'element' && p.elementKind === 'reg').length
    expect(count(builtHigh)).toBe(2)
    expect(
      reviewScheme(builtHigh).find((f) => f.id === 'work-conditions')?.markBlocked,
    ).toBeUndefined()
    const normal = project()
    normal.parameters.regulation.mode = 'one'
    expect(count(rebuildTemplatePlacements(normal).scheme)).toBe(1)
    // Saved explicit two-regulator choices remain reviewable; advice never rewrites objects.
    expect(count(rebuildTemplatePlacements(project()).scheme)).toBe(2)
    normal.parameters.regulation.hourly = '915'
    expect(() => rebuildTemplatePlacements(normal)).toThrow('нужны два')
    expect(reviewScheme(normal).find((f) => f.id === 'b34-traffic')?.markBlocked).toBeTruthy()
  })
  it('limits only the front to 45 m and the pinned PU-66 length', () => {
    const scheme = project(45, '915')
    expect(scheme.template.code).toBe('b33')
    expect(rebuildTemplatePlacements(scheme).scheme.placements.length).toBeGreaterThan(0)
    expect(() => project(45.001)).toThrow()
    const draft = createSchemeDetailsDraft(scheme)
    draft.parameters.workZones.b33!.workMetres = '45.001'
    expect(() => applySchemeDetails(scheme, draft)).toThrow('предел фронта редактора')
    scheme.parameters.workZones.b33!.workMetres = 46
    const opened = importSchemeJson(exportSchemeJson(scheme)).scheme
    expect(opened.parameters.workZones.b33?.workMetres).toBe(46)
    expect(() => rebuildTemplatePlacements(opened)).toThrow('предел фронта редактора')
    expect(reviewScheme(opened).find((f) => f.id === 'work-conditions')?.markBlocked).toContain(
      'предел фронта редактора',
    )
  })
  it('keeps table Д.1 semantics and removes the editable crossing profile', () => {
    expect(workTrafficDecision(41.5, 250, false, PROTOTYPE_RULES, conditions)).toBe('regulators')
    expect(workTrafficDecision(42.6, 915, true, PROTOTYPE_RULES, conditions)).toBe('outside')
    const advice = adviseRegulation({
      ...base,
      hourly: '915',
      zoneSpeedKmh: 40,
      taperMetres: 10,
      sectionMetres: 41.5,
      workConditions: conditions,
    })
    expect(advice.mode).toBe('two')
    expect(advice.verified).toBe(false)
    expect(advice.reasons.join(' ')).toContain('от 250 до 500')
    expect(advice.warnings.join(' ')).toContain('Сверьте применимость')
    expect(parameterDefinition('rail-crossing-profile')).toBeUndefined()
    expect(REGULATION_PARAMETERS).not.toContain('rail-crossing-profile')
  })
  it.each([21.5, 35])(
    'invalidates old review at front %s when normative evidence changes',
    (front) => {
      const scheme = project(front)
      const marked = setMark(scheme, reviewScheme(scheme), 'work-conditions', true)
      const changed = {
        ...PROTOTYPE_RULES,
        evidence: {
          ...PROTOTYPE_RULES.evidence,
          'gost-work-traffic': 'новое учебное основание',
        },
      }
      expect(
        markState(
          marked,
          reviewScheme(marked, changed).find((f) => f.id === 'work-conditions')!,
        ).status,
      ).toBe('stale')
    },
  )
  it('ignores obsolete crossing confirmations and uses the existing normative thresholds', () => {
    const obsolete: ParameterState = {
      id: 'rail-crossing-profile',
      status: { kind: 'confirmed' },
      document: null,
      quote: null,
      suggestion: null,
      amendments: [],
      confirmation: {
        id: 1,
        parameterId: 'rail-crossing-profile',
        documentId: null,
        documentLabel: '',
        clause: '',
        page: null,
        quote: '',
        fragment: '',
        value: {
          'Максимальный фронт на переезде, м': '999',
          'Б.34: знаки при нормальной видимости, до включительно, авт/ч': '999',
          'Б.34: один регулировщик при дневных работах и прямом участке, до включительно, авт/ч':
            '9999',
        },
        confirmedBy: 'Учебный специалист',
        confirmedAt: '2030-01-01',
        note: 'Старое основание',
      },
    }
    const rules = rulesFrom([obsolete])
    expect(rules).toEqual(PROTOTYPE_RULES)
    expect(railRegulationMode({ ...base, hourly: 250 }, rules)).toBe('one')
    expect(railRegulationMode({ ...base, hourly: 501 }, rules)).toBe('two')
  })
  it('does not allow signs when the measured device section reaches 50 m', () => {
    const scheme = project(21.5, '249')
    scheme.parameters.regulation.mode = 'signs'
    scheme.parameters.workZones.b34!.taperMetres = 15
    scheme.parameters.workConditions.sectionMetres = 50
    expect(() => rebuildTemplatePlacements(scheme)).toThrow('Выбранный режим')
    expect(reviewScheme(scheme).find((f) => f.id === 'b34-traffic')?.markBlocked).toBeTruthy()
  })
})
