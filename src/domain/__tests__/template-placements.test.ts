import { describe, expect, it } from 'vitest'
import { createUnlinkedScheme } from '../create-scheme'
import { createPlacementDraft, newTextDraft, savePlacement } from '../edit-placements'
import { movePlacement } from '../placement-workspace'
import { schemeSchema, type Scheme } from '../model'
import {
  buildTemplatePlacements,
  rebuildTemplatePlacements,
  settlementSteps,
  TemplateBuildError,
} from '../template-placements'

function example(
  front: number,
  location: 'in' | 'out',
  mode: Scheme['parameters']['regulation']['mode'],
) {
  const base = createUnlinkedScheme({
    referenceId: 'TEST-TEMPLATE',
    locationText: 'Учебная дорога',
    directionLeft: 'А',
    directionRight: 'Б',
    frontMetres: String(front),
    taperMetres: mode === 'signs' ? '15' : '10',
    bufferMetres: front < 30 ? '10' : '15',
    speedStagesKmh: ['70', '50', '40'],
    yellowTemporarySigns: true,
  })
  return schemeSchema.parse({
    ...base,
    parameters: {
      ...base.parameters,
      location,
      signDistancesMetres: { d300: 300, d250: 250, d150: 150, d50: 50, n100: 100, n50: 50 },
      regulation: { ...base.parameters.regulation, mode, hourly: '180', straight: true },
    },
  })
}

describe('preliminary B.33/B.34 layout', () => {
  it.each([
    [40, 'out', 'two', 2, false],
    [40, 'in', 'two', 2, false],
    [18, 'out', 'signs', 0, true],
    [18, 'in', 'signs', 0, true],
    [18, 'out', 'one', 1, false],
    [18, 'in', 'one', 1, false],
    [18, 'out', 'two', 2, false],
    [18, 'in', 'two', 2, false],
  ] as const)(
    'builds %i m / %s / %s with %i regulators',
    (front, location, mode, count, priority) => {
      const scheme = example(front, location, mode)
      const placements = buildTemplatePlacements(scheme)
      expect(placements.filter((item) => item.kind === 'sign-post')).toHaveLength(
        location === 'out' ? 12 : 8,
      )
      expect(
        placements.filter((item) => item.kind === 'element' && item.elementKind === 'reg'),
      ).toHaveLength(count)
      expect(placements.every((item) => item.generatedByTemplate)).toBe(true)
      const codes = placements.flatMap((item) => (item.kind === 'sign-post' ? item.signIds : []))
      expect(codes.includes('2.6_ж')).toBe(priority)
      expect(codes.includes('2.7')).toBe(priority)
      expect(codes.some((code) => code.startsWith('8.1.1'))).toBe(priority)
      // Начало и конец работ: 1.25 с табличкой 8.2.1 на обоих подходах, конец ограничений 3.31.
      expect(codes.filter((code) => code === '8.2.1')).toHaveLength(2)
      expect(codes.filter((code) => code === '3.31')).toHaveLength(2)
      expect(codes).toContain('3.24_40_ж')
      expect(
        placements.some(
          (item) =>
            item.kind === 'sign-post' &&
            item.distanceLabel === (location === 'in' ? '{n100}' : '{d300}'),
        ),
      ).toBe(true)
      expect(rebuildTemplatePlacements(scheme).scheme.placements).toEqual(placements)
    },
  )

  it('preserves manual edits and replaces only the generated set on rebuild', () => {
    const scheme = example(18, 'out', 'two')
    const manual = newTextDraft()
    if (manual.kind !== 'element') throw new Error('Expected text')
    manual.text = 'Ручная пометка'
    const withManual = savePlacement(scheme, manual)
    const first = rebuildTemplatePlacements(withManual).scheme
    const second = rebuildTemplatePlacements(first).scheme
    expect(second.placements[0]).toEqual(withManual.placements[0])
    expect(second.placements.filter((item) => !item.generatedByTemplate)).toHaveLength(1)
    expect(second.placements.length).toBe(first.placements.length)
    expect(new Set(second.placements.map((item) => item.id)).size).toBe(second.placements.length)
  })

  it('rejects missing decisions and conditions that do not justify 2.6/2.7 or one regulator', () => {
    const scheme = example(18, 'out', 'signs')
    const inadequate = schemeSchema.parse({
      ...scheme,
      parameters: {
        ...scheme.parameters,
        regulation: { ...scheme.parameters.regulation, hourly: '250' },
      },
    })
    expect(() => buildTemplatePlacements(inadequate)).toThrow(TemplateBuildError)
    const one = example(18, 'out', 'one')
    expect(() =>
      buildTemplatePlacements(
        schemeSchema.parse({
          ...one,
          parameters: {
            ...one.parameters,
            regulation: { ...one.parameters.regulation, straight: false },
          },
        }),
      ),
    ).toThrow('прямого участка')
    const noLocation = schemeSchema.parse({
      ...scheme,
      parameters: { ...scheme.parameters, location: 'auto' },
    })
    expect(() => buildTemplatePlacements(noLocation)).toThrow('населённом пункте')
  })

  it('does not duplicate a template object that was moved or edited by hand', () => {
    const built = rebuildTemplatePlacements(example(40, 'out', 'two')).scheme
    const post = built.placements.find((item) => item.kind === 'sign-post')!
    const moved = movePlacement(built, post.id, 5, 0)
    const again = rebuildTemplatePlacements(moved)
    expect(again.keptSlots).toBe(1)
    expect(again.scheme.placements).toHaveLength(built.placements.length)
    const withSlot = again.scheme.placements.filter(
      (item) => item.templateSlot === post.templateSlot,
    )
    expect(withSlot).toHaveLength(1)
    expect(withSlot[0]).toMatchObject({ id: post.id, generatedByTemplate: false })

    const cone = built.placements.find(
      (item) => item.kind === 'element' && item.elementKind === 'car',
    )!
    const edited = savePlacement(built, createPlacementDraft(cone))
    const editedCone = edited.placements.find((item) => item.id === cone.id)!
    expect(editedCone).toMatchObject({
      templateSlot: cone.templateSlot,
      generatedByTemplate: false,
    })
    expect(rebuildTemplatePlacements(edited).scheme.placements).toHaveLength(
      built.placements.length,
    )
  })

  it('requires an entered hourly intensity for 2.6/2.7', () => {
    const scheme = example(18, 'out', 'signs')
    for (const hourly of ['', '  ', 'нет', '-5']) {
      const candidate = schemeSchema.parse({
        ...scheme,
        parameters: {
          ...scheme.parameters,
          regulation: { ...scheme.parameters.regulation, hourly },
        },
      })
      expect(() => buildTemplatePlacements(candidate)).toThrow('интенсивность менее 250')
    }
  })

  it('composes out-of-settlement posts as on figures B.33/B.34', () => {
    const posts = buildTemplatePlacements(example(40, 'out', 'two')).flatMap((item) =>
      item.kind === 'sign-post' ? [[item.signIds.join('+'), item.distanceLabel]] : [],
    )
    expect(posts).toEqual([
      ['1.25', '{d300}'],
      ['3.24_70_ж+3.20_ж', '{d250}'],
      ['3.24_ж+1.20.2_ж', '{d150}'],
      ['3.24_40_ж', '{d50}'],
      ['8.2.1+1.25', '0'],
      ['3.20_ж+3.31', null],
      ['1.25+8.2.1', '0'],
      ['3.24_40_ж', '{d50}'],
      ['1.20.3_ж+3.24_ж', '{d150}'],
      ['3.20_ж+3.24_70_ж', '{d250}'],
      ['1.25', '{d300}'],
      ['3.31+3.20_ж', null],
    ])
  })

  it('adds speed steps of at most 20 km/h in a settlement', () => {
    expect(settlementSteps(60, 40)).toEqual([])
    expect(settlementSteps(90, 40)).toEqual([70, 50])
    const scheme = example(18, 'in', 'two')
    const faster = schemeSchema.parse({
      ...scheme,
      parameters: { ...scheme.parameters, settlementSpeedKmh: 80 },
    })
    const first = buildTemplatePlacements(faster).find((item) => item.kind === 'sign-post')
    expect(first).toMatchObject({ signIds: ['1.25', '3.24_60_ж'], distanceLabel: '{n100}' })
  })

  it('reports hand-edited objects of the previous template version on rebuild', () => {
    const built = rebuildTemplatePlacements(example(40, 'out', 'two')).scheme
    expect(built.template.projectionVersion).toBe('draft-2')
    const legacy = schemeSchema.parse({
      ...built,
      placements: built.placements.map((item, index) =>
        index === 0 ? { ...item, generatedByTemplate: false, templateSlot: 'post:up:0' } : item,
      ),
    })
    expect(rebuildTemplatePlacements(legacy)).toMatchObject({ keptSlots: 0, staleSlots: 1 })
  })

  it('takes the 8.1.1 plate distance only from the entered value', () => {
    const scheme = example(18, 'out', 'signs')
    const plate = (d150: number | null) =>
      buildTemplatePlacements(
        schemeSchema.parse({
          ...scheme,
          parameters: {
            ...scheme.parameters,
            signDistancesMetres: { ...scheme.parameters.signDistancesMetres, d150 },
          },
        }),
      )
        .flatMap((item) => (item.kind === 'sign-post' ? item.signIds : []))
        .find((code) => code.startsWith('8.1.1'))
    expect(plate(150)).toBe('8.1.1_150')
    expect(plate(175)).toBe('8.1.1_175')
    expect(plate(300)).toBe('8.1.1')
    expect(() => plate(null)).toThrow('укажите расстояние d150')
    expect(() => plate(150.5)).toThrow('целым числом')
  })

  it('keeps a hand-edited post in its meaning when the layout switches to a settlement', () => {
    const outside = rebuildTemplatePlacements(example(18, 'out', 'two')).scheme
    const start = outside.placements.find((item) => item.templateSlot === 'post2:L:start')!
    const moved = movePlacement(outside, start.id, 12, 0)
    const inside = schemeSchema.parse({
      ...moved,
      parameters: { ...moved.parameters, location: 'in' },
    })
    const rebuilt = rebuildTemplatePlacements(inside)
    const posts = rebuilt.scheme.placements.filter((item) => item.kind === 'sign-post')
    expect(posts).toHaveLength(8)
    expect(posts.filter((item) => item.templateSlot === 'post2:L:start')).toEqual([
      expect.objectContaining({ id: start.id, generatedByTemplate: false }),
    ])
    expect(posts.some((item) => item.templateSlot === 'post2:R:start')).toBe(true)
    expect(rebuilt).toMatchObject({ keptSlots: 1, staleSlots: 0 })
    const slots = posts.map((item) => item.templateSlot)
    expect(new Set(slots).size).toBe(slots.length)
  })
})
