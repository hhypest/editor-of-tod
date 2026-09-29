import { describe, expect, it } from 'vitest'
import { createNewScheme } from '../create-scheme'
import { createPlacementDraft, newTextDraft, savePlacement } from '../edit-placements'
import { movePlacement } from '../placement-workspace'
import { schemeSchema, type Scheme } from '../model'
import {
  buildTemplatePlacements,
  rebuildTemplatePlacements,
  TemplateBuildError,
} from '../template-placements'

function example(
  front: number,
  location: 'in' | 'out',
  mode: Scheme['parameters']['regulation']['mode'],
) {
  const base = createNewScheme({
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
      expect(placements.filter((item) => item.kind === 'sign-post')).toHaveLength(10)
      expect(
        placements.filter((item) => item.kind === 'element' && item.elementKind === 'reg'),
      ).toHaveLength(count)
      expect(placements.every((item) => item.generatedByTemplate)).toBe(true)
      const codes = placements.flatMap((item) => (item.kind === 'sign-post' ? item.signIds : []))
      expect(codes.includes('2.6')).toBe(priority)
      expect(codes.includes('2.7')).toBe(priority)
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
      (item) => item.kind === 'element' && item.position.zoneFraction === 0.33,
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
})
