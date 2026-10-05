import { describe, expect, it } from 'vitest'
import { createUnlinkedScheme } from '../create-scheme'
import { createPlacementDraft, newTextDraft, savePlacement } from '../edit-placements'
import { anchorCoordinates, movePlacement, placementCoordinates } from '../placement-workspace'
import { PROTOTYPE_RULES } from '../normative-parameters'
import { setMark, unmarkedChecks } from '../review-marks'
import { reviewScheme } from '../review-scheme'
import { schemeSchema, type Scheme } from '../model'
import {
  buildTemplatePlacements,
  rebuildTemplatePlacements,
  dangerousSectionMetres,
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
  return schemeSchema.parse({
    ...base,
    parameters: {
      ...base.parameters,
      location,
      approachSpeedKmh: location === 'in' ? 60 : 90,
      signDistancesMetres: { d300: 300, d250: 250, d150: 150, d50: 50, n100: 100, n50: 50 },
      regulation: { ...base.parameters.regulation, mode, hourly: '180', straight: true },
    },
  })
}

describe('preliminary B.33/B.34 layout', () => {
  it('uses device-section length as well as the short front for priority signs', () => {
    const base = example(25, 'out', 'signs')
    expect(() => buildTemplatePlacements(base)).toThrow('Выбранный режим')
    const finding = reviewScheme(base).find((item) => item.id === 'b34-traffic')
    expect(finding?.markBlocked).toBeTruthy()
    expect(finding?.detail).toContain('ГОСТ Р 58350')
    expect(finding?.detail).toContain('50 м')
  })
  it('allows two regulators above 500 in the specialist profile and preserves imported objects', () => {
    const base = example(18, 'out', 'two')
    const built = rebuildTemplatePlacements(base).scheme
    const outside = {
      ...built,
      parameters: {
        ...built.parameters,
        regulation: { ...built.parameters.regulation, hourly: '501' },
      },
    }
    expect(buildTemplatePlacements(outside).length).toBeGreaterThan(0)
    expect(
      reviewScheme(outside).find((item) => item.id === 'b34-traffic')?.markBlocked,
    ).toBeUndefined()
    expect(outside.placements).toBe(built.placements)
  })
  it('requires exactly one regulator on each approach after manual moves', () => {
    for (const front of [18, 40]) {
      const built = rebuildTemplatePlacements(example(front, 'out', 'two')).scheme
      const anchors = anchorCoordinates(built)
      const regulators = built.placements.filter(
        (p) => p.kind === 'element' && p.elementKind === 'reg',
      )
      const left = regulators[0]!
      const right = regulators[1]!
      const leftX = placementCoordinates(left, anchors).x
      const rightX = placementCoordinates(right, anchors).x
      const bothLeft = movePlacement(built, right.id, leftX - rightX - 40, 0)
      const bothRight = movePlacement(built, left.id, rightX - leftX + 40, 0)
      const inZone = movePlacement(built, right.id, (anchors.Z0 + anchors.Z1) / 2 - rightX, 0)
      const three = {
        ...built,
        placements: [...built.placements, { ...right, id: built.nextPlacementId }],
      }
      const finding = (scheme: Scheme) =>
        reviewScheme(scheme).find((p) => p.id === 'regulator-distance')
      expect(finding(built)).toBeUndefined()
      expect(finding(bothLeft)?.detail).toContain('конца работ (Z1): 0 вместо 1')
      expect(finding(bothRight)?.detail).toContain('начала работ (Z0): 0 вместо 1')
      expect(finding(inZone)?.detail).toContain('стоит над рабочей зоной')
      expect(finding(three)?.detail).toContain('3 из 2')
    }
  })
  it('refuses to place two regulators when the zone speed is not in table 5', () => {
    for (const front of [18, 40]) {
      const base = example(front, 'out', 'two')
      const scheme = {
        ...base,
        parameters: {
          ...base.parameters,
          speedStagesKmh: [70, 50, 45] as [number, number, number],
        },
      }
      expect(() => buildTemplatePlacements(scheme)).toThrow(TemplateBuildError)
      expect(() => buildTemplatePlacements(scheme)).toThrow('45 км/ч нет в таблице')
    }
  })

  it('checks the actual regulator positions against table 5 in the review', () => {
    const built = rebuildTemplatePlacements(example(18, 'out', 'two')).scheme
    expect(reviewScheme(built).some((finding) => finding.id === 'regulator-distance')).toBe(false)
    // Прежняя раскладка: правый регулировщик над местом работ (E − 34).
    const regulators = built.placements.filter(
      (item) => item.kind === 'element' && item.elementKind === 'reg',
    )
    const right = regulators.find((item) => item.position.anchor === 'E')!
    const moved = {
      ...built,
      placements: built.placements.map((item) =>
        item.id === right.id && item.kind === 'element'
          ? { ...item, position: { ...item.position, offsetXSvg: -34 } }
          : item,
      ),
    }
    const finding = reviewScheme(moved).find((item) => item.id === 'regulator-distance')
    expect(finding?.kind).toBe('verify')
    expect(finding?.detail).toContain(`№ ${right.id} стоит над рабочей зоной`)
    // Несоответствие нельзя принять отметкой: пункт блокирует выпуск (CR-02).
    expect(finding?.markBlocked).toContain('Выпуск недоступен')
    expect(() => setMark(moved, reviewScheme(moved), 'regulator-distance', true)).toThrow(
      'Выпуск недоступен',
    )
    expect(unmarkedChecks(moved, reviewScheme(moved)).map((item) => item.id)).toContain(
      'regulator-distance',
    )
    expect(finding?.detail).toContain('не ближе 15 м')
    const oneLeft = {
      ...built,
      placements: built.placements.filter((item) => item.id !== right.id),
    }
    expect(
      reviewScheme(oneLeft).find((item) => item.id === 'regulator-distance')?.detail,
    ).toContain('регулировщиков: 1 из 2')
  })

  it('puts two regulators before the work zone for each direction (ODM 13.7.3, table 5)', () => {
    for (const front of [18, 40]) {
      const scheme = example(front, 'out', 'two')
      const anchors = anchorCoordinates(scheme)
      const zone = scheme.parameters.workZones[scheme.template.code]!
      const unitsPerMetre = (anchors.Z1 - anchors.Z0) / zone.workMetres
      const regulators = buildTemplatePlacements(scheme)
        .filter((item) => item.kind === 'element' && item.elementKind === 'reg')
        .map((item) => placementCoordinates(item, anchors).x)
        .sort((a, b) => a - b)
      expect(regulators).toHaveLength(2)
      const [left, right] = regulators as [number, number]
      // Скорость в зоне 40 км/ч → 15 м по табл. 5; оба регулировщика вне места работ.
      const minimum = 15 * unitsPerMetre
      expect(anchors.Z0 - left).toBeGreaterThanOrEqual(minimum - 1)
      expect(left).toBeLessThan(anchors.L0)
      expect(right - anchors.Z1).toBeGreaterThanOrEqual(minimum - 1)
      expect(right).toBeGreaterThan(anchors.E)
    }
    // Подтверждённое расстояние больше — регулировщики отодвигаются.
    const scheme = example(18, 'out', 'two')
    const anchors = anchorCoordinates(scheme)
    const far = {
      ...PROTOTYPE_RULES,
      regulatorDistance: { ...PROTOTYPE_RULES.regulatorDistance, 40: 30 },
    }
    const right = Math.max(
      ...buildTemplatePlacements(scheme, far)
        .filter((item) => item.kind === 'element' && item.elementKind === 'reg')
        .map((item) => placementCoordinates(item, anchors).x),
    )
    expect(right - anchors.Z1).toBeGreaterThanOrEqual(30 * ((anchors.Z1 - anchors.Z0) / 18) - 1)
  })

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
      // На табличке — протяжённость от начала отвода до конца работ (ГОСТ Р 52289, п. 5.9.5).
      const zone = scheme.parameters.workZones[scheme.template.code]!
      const length = zone.taperMetres + zone.bufferMetres + zone.workMetres
      expect(codes.filter((code) => code === `8.2.1_${length}`)).toHaveLength(2)
      expect(codes).not.toContain('8.2.1')
      expect(codes.filter((code) => code === '3.31')).toHaveLength(2)
      expect(codes).toContain('3.24_40_ж')
      expect(
        placements.some(
          (item) =>
            item.kind === 'sign-post' &&
            item.distance?.by === 'marker' &&
            item.distance.marker === (location === 'in' ? 'n100' : 'd300'),
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
        regulation: { ...scheme.parameters.regulation, hourly: '251' },
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
      expect(() => buildTemplatePlacements(candidate)).toThrow(TemplateBuildError)
    }
  })

  it('composes out-of-settlement posts as on figures B.33/B.34', () => {
    const posts = buildTemplatePlacements(example(40, 'out', 'two')).flatMap((item) =>
      item.kind === 'sign-post'
        ? [
            [
              item.signIds.join('+'),
              // Расстояние стойки: поле этапа 2, «0» у начала работ или его нет (за зоной).
              !item.distance
                ? null
                : item.distance.by === 'marker'
                  ? `{${item.distance.marker}}`
                  : String(item.distance.metres),
            ],
          ]
        : [],
    )
    expect(posts).toEqual([
      ['1.25', '{d300}'],
      ['3.24_70_ж+3.20_ж', '{d250}'],
      ['3.24_ж+1.20.2_ж', '{d150}'],
      ['3.24_40_ж', '{d50}'],
      ['8.2.1_65+1.25', '0'],
      ['3.20_ж+3.31', null],
      ['1.25+8.2.1_65', '0'],
      ['3.24_40_ж', '{d50}'],
      ['1.20.3_ж+3.24_ж', '{d150}'],
      ['3.20_ж+3.24_70_ж', '{d250}'],
      ['1.25', '{d300}'],
      ['3.31+3.20_ж', null],
    ])
  })

  it('writes the dangerous section length on 8.2.1 rounded to whole metres', () => {
    const scheme = example(18, 'out', 'two')
    const fractional = schemeSchema.parse({
      ...scheme,
      parameters: {
        ...scheme.parameters,
        workZones: {
          ...scheme.parameters.workZones,
          b34: { ...scheme.parameters.workZones.b34!, taperMetres: 10.1, workMetres: 18.2 },
        },
      },
    })
    // 10,1 + 10 + 18,2 = 38,3 м → 38 м: протяжённость на табличке округляется до целых.
    expect(dangerousSectionMetres(fractional)).toBe(38)
    const half = schemeSchema.parse({
      ...fractional,
      parameters: {
        ...fractional.parameters,
        workZones: {
          ...fractional.parameters.workZones,
          b34: { ...fractional.parameters.workZones.b34!, workMetres: 27.4 },
        },
      },
    })
    // 10,1 + 10 + 27,4 = 47,5 → 48 (половина — вверх, без погрешности сложения дробей).
    expect(dangerousSectionMetres(half)).toBe(48)
    const codes = buildTemplatePlacements(fractional).flatMap((item) =>
      item.kind === 'sign-post' ? item.signIds : [],
    )
    expect(codes.filter((code) => code === '8.2.1_38')).toHaveLength(2)
  })

  it('adds speed steps of at most 20 km/h in a settlement', () => {
    expect(settlementSteps(60, 40)).toEqual([])
    expect(settlementSteps(90, 40)).toEqual([70, 50])
    const scheme = example(18, 'in', 'two')
    const faster = schemeSchema.parse({
      ...scheme,
      parameters: { ...scheme.parameters, approachSpeedKmh: 80 },
    })
    const first = buildTemplatePlacements(faster).find((item) => item.kind === 'sign-post')
    expect(first).toMatchObject({
      signIds: ['1.25', '3.24_60_ж'],
      distance: { by: 'marker', approach: 'left', marker: 'n100' },
      distanceLabel: null,
    })
    const unknown = schemeSchema.parse({
      ...scheme,
      parameters: { ...scheme.parameters, approachSpeedKmh: null },
    })
    expect(() => buildTemplatePlacements(unknown)).toThrow('разрешённую скорость на подходе')
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
    expect(() => plate(null)).toThrow('укажите расстояние «Вторая ступень 3.24 и сужение 1.20»')
    expect(() => plate(150.5)).toThrow('целым числом')
  })

  it('keeps a hand-edited post in its meaning when the layout switches to a settlement', () => {
    const outside = rebuildTemplatePlacements(example(18, 'out', 'two')).scheme
    const start = outside.placements.find((item) => item.templateSlot === 'post2:L:start')!
    const moved = movePlacement(outside, start.id, 12, 0)
    const inside = schemeSchema.parse({
      ...moved,
      parameters: { ...moved.parameters, location: 'in', approachSpeedKmh: 60 },
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

  it('requires exactly one regulator on the sheet in the one-regulator mode', () => {
    const base = example(18, 'out', 'one')
    const finding = (scheme: Scheme) =>
      reviewScheme(scheme).find((item) => item.id === 'regulator-distance')
    expect(finding(base)?.markBlocked).toContain('регулировщиков: 0 из 1')
    const two = rebuildTemplatePlacements(example(18, 'out', 'two')).scheme.placements.filter(
      (item) => item.kind === 'element' && item.elementKind === 'reg',
    )
    expect(finding({ ...base, placements: [two[0]!] })).toBeUndefined()
    // Раскладка шаблона для одного регулировщика проходит проверку без правок.
    expect(finding(rebuildTemplatePlacements(base).scheme)).toBeUndefined()
    expect(finding({ ...base, placements: two })?.markBlocked).toContain('регулировщиков: 2 из 1')
    // Знаки 2.6/2.7: регулировщики не требуются, пункт не появляется.
    expect(finding(example(18, 'out', 'signs'))).toBeUndefined()
  })
})
