import { describe, expect, it } from 'vitest'
import { createUnlinkedScheme, newSchemeDefaults } from '../create-scheme'
import {
  changeDraftApproach,
  changeDraftLocation,
  createSchemeDetailsDraft,
  resetDraftToNormative,
} from '../edit-details'
import {
  changeApproachSpeed,
  defaultSpeedStages,
  largestSpeedStep,
  normativeDeviations,
  normativeMarks,
  switchLocation,
  warningDistanceProblem,
} from '../normative-defaults'
import {
  parameterDefinition,
  PROTOTYPE_RULES,
  rulesFrom,
  suggestValue,
  type ParameterState,
} from '../normative-parameters'
import { detailsDraftSchema } from '../recovery'
import { reviewScheme } from '../review-scheme'

const rules = PROTOTYPE_RULES

function project(location: 'in' | 'out' = 'out') {
  const defaults = newSchemeDefaults(location, rules)
  return createUnlinkedScheme(
    {
      referenceId: 'TEST-DEFAULTS',
      locationText: 'Учебный участок',
      directionLeft: 'А',
      directionRight: 'Б',
      frontMetres: '40',
      taperMetres: '10',
      bufferMetres: '15',
      location,
      ...defaults,
      yellowTemporarySigns: false,
    },
    { id: '55740b36-080a-4cbe-9476-e71ffb1ab47f', now: '2026-10-01T09:00:00.000Z', rules },
  )
}

describe('normative defaults of distances and speeds', () => {
  it('takes the ODM figure values outside and the GOST 5.2.2 bounds in a settlement', () => {
    expect(newSchemeDefaults('out', rules)).toEqual({
      approachSpeedKmh: '90',
      speedStagesKmh: ['70', '50', '40'],
    })
    expect(newSchemeDefaults('in', rules)).toEqual({
      approachSpeedKmh: '60',
      speedStagesKmh: ['40', '40', '40'],
    })
    expect(project('out').parameters.signDistancesMetres).toEqual({
      d300: 300,
      d250: 250,
      d150: 150,
      d50: 50,
      n100: null,
      n50: null,
    })
    expect(project('in').parameters.signDistancesMetres).toMatchObject({ n100: 100, n50: 50 })
    expect(normativeDeviations(project().parameters, rules)).toEqual([])
    expect(normativeMarks(project().parameters, rules).map((mark) => mark.state)).toEqual(
      Array(8).fill('normative'),
    )
  })

  it('steps speeds down by the confirmed step, never below the zone speed', () => {
    expect(defaultSpeedStages(90, rules)).toEqual([70, 50, 40])
    expect(defaultSpeedStages(70, rules)).toEqual([50, 40, 40])
    expect(defaultSpeedStages(50, rules)).toEqual([40, 40, 40])
    expect(defaultSpeedStages(90, { ...rules, speedStepKmh: 10, zoneSpeedKmh: 30 })).toEqual([
      80, 70, 30,
    ])
  })

  it('keeps edited values and replaces only defaults when the location changes', () => {
    const outside = project('out').parameters
    const edited = {
      ...outside,
      signDistancesMetres: { ...outside.signDistancesMetres, d300: 280 },
    }
    const inside = switchLocation(edited, 'in', rules)
    expect(inside).toMatchObject({
      location: 'in',
      approachSpeedKmh: 60,
      speedStagesKmh: [40, 40, 40],
      signDistancesMetres: { d300: 280, n100: 100, n50: 50 },
    })
    // Разрешённая скорость и ступени, исправленные вручную, остаются.
    const custom = {
      ...outside,
      approachSpeedKmh: 80,
      speedStagesKmh: [60, 50, 40] as [number, number, number],
    }
    expect(switchLocation(custom, 'in', rules)).toMatchObject({
      approachSpeedKmh: 80,
      speedStagesKmh: [60, 50, 40],
    })
    // Проект v6 вне населённого пункта без скорости получает значения по умолчанию.
    expect(
      switchLocation({ ...outside, location: 'auto', approachSpeedKmh: null }, 'out', rules),
    ).toMatchObject({ approachSpeedKmh: 90, speedStagesKmh: [70, 50, 40] })
  })

  it('recalculates stages after a speed change only while they were not edited', () => {
    const outside = project('out').parameters
    expect(changeApproachSpeed(outside, 70, rules).speedStagesKmh).toEqual([50, 40, 40])
    const edited = { ...outside, speedStagesKmh: [70, 60, 40] as [number, number, number] }
    expect(changeApproachSpeed(edited, 70, rules).speedStagesKmh).toEqual([70, 60, 40])
  })

  it('lists deviations, the GOST 5.2.2 range and oversized speed steps for the review', () => {
    const scheme = project('out')
    const changed = {
      ...scheme,
      parameters: {
        ...scheme.parameters,
        approachSpeedKmh: 110,
        signDistancesMetres: { ...scheme.parameters.signDistancesMetres, d300: 400, d50: null },
      },
    }
    expect(
      normativeDeviations(changed.parameters, rules).map((item) => [item.field, item.state]),
    ).toEqual([
      ['parameters.signDistancesMetres.d300', 'changed'],
      ['parameters.signDistancesMetres.d50', 'empty'],
      ['parameters.approachSpeedKmh', 'changed'],
      ['parameters.speedStagesKmh.0', 'changed'],
      ['parameters.speedStagesKmh.1', 'changed'],
    ])
    expect(warningDistanceProblem(changed.parameters, rules)).toMatchObject({
      value: 400,
      range: [150, 300],
    })
    expect(largestSpeedStep(changed.parameters)).toBe(40)
    const findings = reviewScheme(changed, rules)
    const ids = findings.map((finding) => finding.id)
    expect(ids).toEqual(
      expect.arrayContaining(['normative-values', 'warning-distance', 'speed-step']),
    )
    expect(findings.find((finding) => finding.id === 'normative-values')?.detail).toContain(
      'по нормативу 300, ОДМ 218.6.019, рисунки Б.33 и Б.34',
    )
    expect(findings.find((finding) => finding.id === 'warning-distance')?.detail).toContain('8.1.1')
    // В населённом пункте первые ступени не используются и не сверяются.
    const inside = project('in')
    expect(
      normativeDeviations({ ...inside.parameters, speedStagesKmh: [90, 90, 40] }, rules),
    ).toEqual([])
  })

  it('uses confirmed values of the new parameters and prototype values for renamed rows', () => {
    const table = parameterDefinition('odm-sign-distances-outside')!
    const confirmed = rulesFrom([
      {
        id: 'odm-sign-distances-outside',
        status: { kind: 'confirmed' },
        document: { id: 1, label: 'ОДМ 218.6.019-2016', sha256: 'x' },
        quote: null,
        suggestion: null,
        confirmation: {
          id: 1,
          parameterId: 'odm-sign-distances-outside',
          documentId: 1,
          documentLabel: 'ОДМ 218.6.019-2016',
          clause: 'рисунки Б.33 и Б.34',
          page: 100,
          quote: '',
          fragment: '',
          value: {
            ...(table.type === 'table' ? table.fallback : {}),
            'Знак 1.25 «Дорожные работы»': '280',
          },
          confirmedBy: 'Учебный составитель',
          confirmedAt: '2026-10-01',
          note: 'стр. 100',
        },
        amendments: [],
      } satisfies ParameterState,
    ])
    expect(confirmed.signDistances).toMatchObject({ d300: 280, d250: 250, n100: 100 })
    expect(confirmed.confirmed['odm-sign-distances-outside']).toBe(true)
    expect(confirmed.warningDistance).toEqual({ in: [50, 100], out: [150, 300] })
  })

  it('finds the ПДД speeds in the clause text', () => {
    const settlement = parameterDefinition('pdd-speed-settlement')!
    const outside = parameterDefinition('pdd-speed-outside')!
    expect(
      suggestValue(settlement, {
        text: '10.2. В населённых пунктах разрешается движение транспортных средств со скоростью не более 60 км/ч, а в жилых зонах…',
      }),
    ).toBe(60)
    expect(
      suggestValue(outside, {
        text: '10.3. Вне населённых пунктов разрешается движение: мотоциклам, легковым автомобилям… на автомагистралях — со скоростью не более 110 км/ч, на остальных дорогах — не более 90 км/ч;',
      }),
    ).toBe(90)
  })
})

describe('normative defaults in the details form', () => {
  it('switches location and approach speed in the draft without touching edited fields', () => {
    const draft = createSchemeDetailsDraft(project('out'))
    draft.parameters.signDistancesMetres.d300 = '280'
    draft.parameters.location = 'in'
    changeDraftLocation(draft, 'out', rules)
    expect(draft.parameters).toMatchObject({
      approachSpeedKmh: '60',
      speedStagesKmh: ['40', '40', '40'],
      signDistancesMetres: { d300: '280', n100: '100', n50: '50' },
    })
    draft.parameters.approachSpeedKmh = '80'
    changeDraftApproach(draft, '60', rules)
    expect(draft.parameters.speedStagesKmh).toEqual(['60', '40', '40'])
    // Ввод «50,0» не переписывается, пока значение не меняется.
    draft.parameters.speedStagesKmh[2] = '40,0'
    resetDraftToNormative(draft, rules)
    expect(draft.parameters).toMatchObject({
      approachSpeedKmh: '60',
      speedStagesKmh: ['40', '40', '40,0'],
      signDistancesMetres: { d300: '280', n100: '100', n50: '50' },
    })
  })

  it('reads recovery drafts of v6 with the settlement speed', () => {
    const draft = createSchemeDetailsDraft(project('in'))
    const { approachSpeedKmh, ...parameters } = draft.parameters
    const oldDraft = {
      ...draft,
      parameters: { ...parameters, settlementSpeedKmh: approachSpeedKmh },
    }
    expect(detailsDraftSchema.parse(oldDraft).parameters.approachSpeedKmh).toBe('60')
    const outside = {
      ...oldDraft,
      parameters: { ...oldDraft.parameters, location: 'out' as const },
    }
    expect(detailsDraftSchema.parse(outside).parameters.approachSpeedKmh).toBe('')
  })
})
