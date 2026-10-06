import { describe, expect, it } from 'vitest'
import { createUnlinkedScheme } from '../create-scheme'
import { schemeSchema, type Scheme } from '../model'
import { PROTOTYPE_RULES, rulesFrom, type ParameterState } from '../normative-parameters'
import { plateCountProblems, speedSignKmh, speedSteps, stepIntervalProblems } from '../post-checks'
import { reviewScheme } from '../review-scheme'
import { rebuildTemplatePlacements } from '../template-placements'

function example(location: 'in' | 'out', approachKmh = location === 'in' ? 60 : 90): Scheme {
  const base = createUnlinkedScheme({
    referenceId: 'TEST-POST-CHECKS',
    locationText: 'Учебная дорога',
    directionLeft: 'А',
    directionRight: 'Б',
    frontMetres: '18',
    taperMetres: '10',
    bufferMetres: '10',
    speedStagesKmh: ['70', '50', '40'],
    location: 'out',
    approachSpeedKmh: '90',
    yellowTemporarySigns: true,
    workConditions: {
      kind: 'short',
      durationHours: 5,
      daylight: 'day',
      regulatorsPresent: true,
      sectionMetres: null,
    },
  })
  return rebuildTemplatePlacements(
    schemeSchema.parse({
      ...base,
      parameters: {
        ...base.parameters,
        location,
        approachSpeedKmh: approachKmh,
        signDistancesMetres: { d300: 300, d250: 250, d150: 150, d50: 50, n100: 100, n50: 50 },
        regulation: { ...base.parameters.regulation, mode: 'two', hourly: '180', straight: true },
      },
    }),
  ).scheme
}

function withDistances(
  scheme: Scheme,
  distances: Partial<Scheme['parameters']['signDistancesMetres']>,
) {
  return schemeSchema.parse({
    ...scheme,
    parameters: {
      ...scheme.parameters,
      signDistancesMetres: { ...scheme.parameters.signDistancesMetres, ...distances },
    },
  })
}

function finding(scheme: Scheme, id: string, rules = PROTOTYPE_RULES) {
  return reviewScheme(scheme, rules).find((item) => item.id === id)
}

describe('speed sign code', () => {
  it('reads the limit from the code; the code without a number is the standard image «50»', () => {
    expect(speedSignKmh('3.24_70')).toBe(70)
    expect(speedSignKmh('3.24_40_ж')).toBe(40)
    expect(speedSignKmh('3.24')).toBe(50)
    expect(speedSignKmh('3.24_ж')).toBe(50)
    expect(speedSignKmh('3.25')).toBeNull()
    expect(speedSignKmh('3.24.1')).toBeNull()
  })
})

describe('intervals between consecutive 3.24 signs (ГОСТ Р 52289, п. 5.4.22)', () => {
  it('finds no problem in the template rows of both locations', () => {
    const outside = example('out')
    expect(speedSteps(outside, 'left').map((step) => [step.kmh, step.metres])).toEqual([
      [70, 250],
      [50, 150],
      [40, 50],
    ])
    expect(speedSteps(outside, 'right')).toHaveLength(3)
    expect(stepIntervalProblems(outside, PROTOTYPE_RULES)).toBeNull()
    expect(finding(outside, 'speed-step-interval')).toBeUndefined()

    const settlement = example('in')
    expect(speedSteps(settlement, 'left').map((step) => [step.kmh, step.metres])).toEqual([
      [40, 50],
    ])
    expect(stepIntervalProblems(settlement, PROTOTYPE_RULES)).toBeNull()
  })

  it('warns about an interval outside the range on each approach and names the posts', () => {
    const scheme = withDistances(example('out'), { d150: 180 })
    const result = stepIntervalProblems(scheme, PROTOTYPE_RULES)!
    expect(result.range).toEqual([100, 150])
    expect(
      result.problems.map((problem) => [problem.approach, problem.from.kmh, problem.gapMetres]),
    ).toEqual([
      ['left', 70, 70],
      ['right', 70, 70],
    ])
    const item = finding(scheme, 'speed-step-interval')!
    expect(item.kind).toBe('verify')
    expect(item.markBlocked).toBeUndefined()
    expect(item.detail).toContain('от 100 до 150 м (ГОСТ Р 52289, п. 5.4.22)')
    expect(item.detail).toContain('«70» (стойка № ')
    expect(item.detail).toContain('250 м) и «50»')
    expect(item.detail).toContain('180 м): 70 м')
    expect(item.detail).toContain('ГОСТ Р 58350')
  })

  it('counts a limit from its farthest post and ignores a repeated sign closer to the works', () => {
    const scheme = example('out')
    const zoneSpeed = scheme.placements.find(
      (placement) =>
        placement.kind === 'sign-post' && placement.templateSlot === 'post2:L:zone-speed',
    )!
    const { templateSlot: _slot, ...manual } = zoneSpeed as Extract<
      Scheme['placements'][number],
      { kind: 'sign-post' }
    >
    const repeated = schemeSchema.parse({
      ...scheme,
      nextPlacementId: scheme.nextPlacementId + 1,
      placements: [
        ...scheme.placements,
        {
          ...manual,
          id: scheme.nextPlacementId,
          generatedByTemplate: false,
          signIds: ['3.24_70_ж'],
          distance: { by: 'metres', approach: 'left', metres: 200 },
        },
      ],
    })
    expect(speedSteps(repeated, 'left').map((step) => step.metres)).toEqual([250, 150, 50])
    expect(stepIntervalProblems(repeated, PROTOTYPE_RULES)).toBeNull()
  })

  it('treats the same limit after a different one as a separate step', () => {
    const scheme = example('out')
    const zoneSpeed = scheme.placements.find(
      (placement) =>
        placement.kind === 'sign-post' && placement.templateSlot === 'post2:L:zone-speed',
    )!
    const { templateSlot: _slot, ...manual } = zoneSpeed as Extract<
      Scheme['placements'][number],
      { kind: 'sign-post' }
    >
    const raised = schemeSchema.parse({
      ...scheme,
      nextPlacementId: scheme.nextPlacementId + 1,
      placements: [
        ...scheme.placements,
        {
          ...manual,
          id: scheme.nextPlacementId,
          generatedByTemplate: false,
          signIds: ['3.24_70_ж'],
          distance: { by: 'metres', approach: 'left', metres: 100 },
        },
      ],
    })
    // 70 (250) → 50 (150) → 70 (100) → 40 (50): последние два интервала по 50 м.
    expect(speedSteps(raised, 'left').map((step) => [step.kmh, step.metres])).toEqual([
      [70, 250],
      [50, 150],
      [70, 100],
      [40, 50],
    ])
    expect(
      stepIntervalProblems(raised, PROTOTYPE_RULES)!.problems.map((problem) => [
        problem.from.kmh,
        problem.to.kmh,
        problem.gapMetres,
      ]),
    ).toEqual([
      [50, 70, 50],
      [70, 40, 50],
    ])
  })

  it('skips posts without a distance and an undefined location', () => {
    const scheme = withDistances(example('out'), { d150: 180 })
    const free = schemeSchema.parse({
      ...scheme,
      placements: scheme.placements.map((placement) =>
        placement.kind === 'sign-post' && placement.templateSlot?.endsWith(':narrowing')
          ? { ...placement, distance: null }
          : placement,
      ),
    })
    expect(speedSteps(free, 'left').map((step) => step.kmh)).toEqual([70, 40])
    // 250 → 50 м: теперь это соседние ступени, интервал 200 м.
    expect(stepIntervalProblems(free, PROTOTYPE_RULES)!.problems[0]!.gapMetres).toBe(200)
    expect(
      stepIntervalProblems(
        { ...scheme, parameters: { ...scheme.parameters, location: 'auto' } },
        PROTOTYPE_RULES,
      ),
    ).toBeNull()
  })

  it('reports different limits on one post in a settlement as placed at the same distance', () => {
    const scheme = example('in', 100)
    const result = stepIntervalProblems(scheme, PROTOTYPE_RULES)!
    expect(result.range).toEqual([50, 100])
    expect(result.problems.some((problem) => problem.gapMetres === 0)).toBe(true)
    expect(finding(scheme, 'speed-step-interval')!.detail).toContain('на одном расстоянии')
  })

  it('takes the range from the confirmed parameter and unmarks the check when it changes', () => {
    const state: ParameterState = {
      id: 'gost-speed-step-interval',
      status: { kind: 'confirmed' },
      document: { id: 7, label: 'ГОСТ Р 52289-2019', sha256: 'a'.repeat(64) },
      quote: null,
      suggestion: null,
      confirmation: {
        id: 3,
        parameterId: 'gost-speed-step-interval',
        documentId: 7,
        documentLabel: 'ГОСТ Р 52289-2019',
        clause: 'п. 5.4.22',
        page: null,
        quote: '',
        fragment: '',
        value: { 'Вне населённого пункта': '60–150', 'В населённом пункте': '50–100' },
        confirmedBy: 'Учебный составитель',
        confirmedAt: '2026-10-05T10:00:00.000Z',
        note: '',
      },
      amendments: [],
    }
    const rules = rulesFrom([state])
    expect(rules.speedStepInterval.out).toEqual([60, 150])
    expect(rules.confirmed['gost-speed-step-interval']).toBe(true)
    const scheme = withDistances(example('out'), { d150: 180 })
    expect(stepIntervalProblems(scheme, rules)).toBeNull()

    const narrow = withDistances(example('out'), { d150: 200 })
    expect(finding(narrow, 'speed-step-interval', rules)!.detail).toContain(
      'от 60 до 150 м (ГОСТ Р 52289-2019, п. 5.4.22)',
    )
    expect(finding(narrow, 'speed-step-interval', rules)!.basis).not.toBe(
      finding(narrow, 'speed-step-interval')!.basis,
    )
  })
})

describe('number of plates under one sign (ГОСТ Р 52289, п. 5.9.1)', () => {
  const withPost = (scheme: Scheme, signIds: string[]) =>
    schemeSchema.parse({
      ...scheme,
      placements: scheme.placements.map((placement) =>
        placement.kind === 'sign-post' && placement.templateSlot === 'post2:L:warning'
          ? { ...placement, signIds }
          : placement,
      ),
    })

  it('accepts the template posts, including the priority signs row', () => {
    expect(plateCountProblems(example('out'), PROTOTYPE_RULES)).toEqual([])
    expect(plateCountProblems(example('in'), PROTOTYPE_RULES)).toEqual([])
    expect(finding(example('out'), 'plate-count')).toBeUndefined()
  })

  it('allows one plate with a temporary sign outside a settlement and two inside', () => {
    const signs = ['1.25', '8.1.1_300', '8.2.1_38']
    const outside = withPost(example('out'), signs)
    expect(plateCountProblems(outside, PROTOTYPE_RULES)).toMatchObject([
      { sign: '1.25', plates: 2, limit: 1 },
    ])
    const item = finding(outside, 'plate-count')!
    expect(item.kind).toBe('verify')
    expect(item.detail).toContain('под знаком 1.25 табличек — 2')
    expect(item.detail).toContain('не более 1 (ГОСТ Р 52289, п. 5.9.1)')

    const settlement = withPost(example('in'), signs)
    expect(plateCountProblems(settlement, PROTOTYPE_RULES)).toEqual([])
    expect(
      plateCountProblems(withPost(example('in'), [...signs, '8.4.1']), PROTOTYPE_RULES),
    ).toMatchObject([{ plates: 3, limit: 2 }])
  })

  it('does not limit sign 6.4 and a post of plates only', () => {
    expect(
      plateCountProblems(withPost(example('out'), ['6.4', '8.1.1_100', '8.6.1']), PROTOTYPE_RULES),
    ).toEqual([])
    expect(
      plateCountProblems(withPost(example('out'), ['8.1.1_100', '8.2.1_38']), PROTOTYPE_RULES),
    ).toEqual([])
  })
})
