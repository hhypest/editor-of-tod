import { describe, expect, it } from 'vitest'
import { createUnlinkedScheme } from '../create-scheme'
import { newTextDraft, savePlacement } from '../edit-placements'
import { recordEdit, startHistory, undoEdit } from '../edit-history'
import { schemeSchema, type Scheme } from '../model'
import { PROTOTYPE_RULES } from '../normative-parameters'
import { movePlacement } from '../placement-workspace'
import { rebuildTemplatePlacements } from '../template-placements'
import { autoRebuildTemplate, describeTemplateChanges, slotTitle } from '../template-rebuild'

type Mode = Scheme['parameters']['regulation']['mode']

function example(front: number, location: 'in' | 'out', mode: Mode): Scheme {
  const base = createUnlinkedScheme({
    referenceId: 'TEST-REBUILD',
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

/** Собранный шаблон с ручной пометкой и вручную сдвинутой стойкой первой ступени слева. */
function builtWithManualEdits(front: number, mode: Mode): Scheme {
  const built = rebuildTemplatePlacements(example(front, 'out', mode)).scheme
  const note = newTextDraft()
  if (note.kind !== 'element') throw new Error('Expected text')
  note.text = 'Ручная пометка'
  const withNote = savePlacement(built, note)
  const speed1 = withNote.placements.find((item) => item.templateSlot === 'post2:L:speed1')!
  return movePlacement(withNote, speed1.id, 5, 0)
}

const withParameters = (scheme: Scheme, parameters: Partial<Scheme['parameters']>): Scheme =>
  schemeSchema.parse({ ...scheme, parameters: { ...scheme.parameters, ...parameters } })

const manualOf = (scheme: Scheme) => scheme.placements.filter((item) => !item.generatedByTemplate)
const slots = (scheme: Scheme) =>
  scheme.placements.flatMap((item) => (item.templateSlot ? [item.templateSlot] : [])).sort()

describe('automatic rebuild of template objects on stage 2 edits (#106)', () => {
  it('rebuilds out of settlement → in settlement, keeping manual objects and edited slots', () => {
    const before = builtWithManualEdits(18, 'two')
    const next = withParameters(before, { location: 'in', approachSpeedKmh: 60 })
    const result = autoRebuildTemplate(before, next, PROTOTYPE_RULES)
    if (result.kind !== 'rebuilt') throw new Error(`Expected rebuild, got ${result.kind}`)
    // Ручная пометка и сдвинутая вручную стойка не тронуты.
    expect(manualOf(result.scheme)).toEqual(manualOf(before))
    expect(result.changes.staleSlots).toBe(1)
    // В населённом пункте нет отдельных стоек второй ступени и скорости в зоне.
    expect(result.changes.removed).toEqual(
      expect.arrayContaining(['скорость в зоне слева', 'скорость в зоне справа']),
    )
    expect(slots(result.scheme)).not.toContain('post2:L:zone-speed')
    // Слот, изменённый вручную, не дублируется.
    expect(slots(result.scheme).filter((slot) => slot === 'post2:L:speed1')).toHaveLength(1)
    expect(result.message).toContain('Типовые объекты перестроены по новым параметрам')
    expect(result.message).toContain('Ручные объекты сохранены.')
    expect(result.message).toContain('Изменённых вручную объектов прежней раскладки: 1')
    // И обратно — вне населённого пункта: стойки скорости в зоне возвращаются.
    const back = autoRebuildTemplate(
      result.scheme,
      withParameters(result.scheme, { location: 'out', approachSpeedKmh: 90 }),
      PROTOTYPE_RULES,
    )
    if (back.kind !== 'rebuilt') throw new Error('Expected rebuild')
    expect(back.changes.added).toEqual(expect.arrayContaining(['скорость в зоне слева']))
    expect(manualOf(back.scheme)).toEqual(manualOf(before))
  })

  it('adds and removes regulators on signs ↔ regulators and keeps ids of unchanged slots', () => {
    const before = builtWithManualEdits(18, 'two')
    const regulators = (scheme: Scheme) =>
      scheme.placements.filter((item) => item.kind === 'element' && item.elementKind === 'reg')
    expect(regulators(before)).toHaveLength(2)
    const signs = withParameters(before, {
      regulation: { ...before.parameters.regulation, mode: 'signs' },
      workZones: {
        ...before.parameters.workZones,
        b34: { ...before.parameters.workZones.b34!, taperMetres: 15 },
      },
    })
    const toSigns = autoRebuildTemplate(before, signs, PROTOTYPE_RULES)
    if (toSigns.kind !== 'rebuilt') throw new Error(`Expected rebuild, got ${toSigns.kind}`)
    expect(regulators(toSigns.scheme)).toHaveLength(0)
    expect(toSigns.changes.removed.filter((title) => title === 'регулировщик')).toHaveLength(2)
    expect(toSigns.message).toContain('регулировщик ×2')
    // Знак 2.6 появился у начала работ слева.
    const start = toSigns.scheme.placements.find((item) => item.templateSlot === 'post2:L:start')!
    expect(start.kind === 'sign-post' && start.signIds.some((code) => code.startsWith('2.6'))).toBe(
      true,
    )
    // Неизменившийся объект сохраняет номер: автомобиль прикрытия.
    const car = (scheme: Scheme) =>
      scheme.placements.find((item) => item.kind === 'element' && item.elementKind === 'car')!
    expect(car(toSigns.scheme).id).toBe(car(before).id)
    expect(new Set(toSigns.scheme.placements.map((item) => item.id)).size).toBe(
      toSigns.scheme.placements.length,
    )
    const toOne = autoRebuildTemplate(
      toSigns.scheme,
      withParameters(toSigns.scheme, {
        regulation: { ...toSigns.scheme.parameters.regulation, mode: 'one' },
        workZones: {
          ...toSigns.scheme.parameters.workZones,
          b34: { ...toSigns.scheme.parameters.workZones.b34!, taperMetres: 10 },
        },
      }),
      PROTOTYPE_RULES,
    )
    if (toOne.kind !== 'rebuilt') throw new Error(`Expected rebuild, got ${toOne.kind}`)
    expect(regulators(toOne.scheme)).toHaveLength(1)
    expect(toOne.changes.added).toContain('регулировщик')
  })

  it('rebuilds B.33 → B.34 with manual edits, then one undo returns parameters and objects', () => {
    const before = builtWithManualEdits(40, 'two')
    expect(before.template.code).toBe('b33')
    const zone = before.parameters.workZones.b33!
    const next = schemeSchema.parse({
      ...before,
      template: { ...before.template, code: 'b34' },
      parameters: {
        ...before.parameters,
        frontStyle: 'part',
        workZones: {
          ...before.parameters.workZones,
          b34: { ...zone, taperMetres: 10, bufferMetres: 10, workMetres: 25 },
        },
      },
    })
    const result = autoRebuildTemplate(before, next, PROTOTYPE_RULES)
    if (result.kind !== 'rebuilt') throw new Error(`Expected rebuild, got ${result.kind}`)
    expect(result.changes.added.filter((title) => title === 'место работ')).toHaveLength(4)
    expect(result.message).toContain('место работ ×4')
    expect(manualOf(result.scheme)).toEqual(manualOf(before))
    // Перестройка входит в то же действие истории, что и правка.
    const history = recordEdit(startHistory(before), result.scheme)
    expect(undoEdit(history).present).toBe(before)
  })

  it('does nothing before the template is built, for edits that do not affect the layout, or when nothing changes', () => {
    const plain = example(18, 'out', 'two')
    expect(
      autoRebuildTemplate(
        plain,
        withParameters(plain, { location: 'in', approachSpeedKmh: 60 }),
        PROTOTYPE_RULES,
      ),
    ).toEqual({ kind: 'none' })
    const built = rebuildTemplatePlacements(plain).scheme
    const renamed = withParameters(built, { locationText: 'Другая надпись участка' })
    expect(autoRebuildTemplate(built, renamed, PROTOTYPE_RULES)).toEqual({ kind: 'none' })
    // Видимость меняет только рекомендацию, не раскладку.
    const visibility = withParameters(built, {
      regulation: { ...built.parameters.regulation, vis: true },
    })
    expect(autoRebuildTemplate(built, visibility, PROTOTYPE_RULES)).toEqual({ kind: 'none' })
  })

  it('recognizes a built template after every original object was edited manually', () => {
    const built = rebuildTemplatePlacements(example(18, 'in', 'two')).scheme
    const before = built.placements.reduce(
      (scheme, placement) => movePlacement(scheme, placement.id, 0, 1),
      built,
    )
    expect(before.placements.every((placement) => !placement.generatedByTemplate)).toBe(true)
    const next = withParameters(before, { location: 'out', approachSpeedKmh: 90 })
    const result = autoRebuildTemplate(before, next, PROTOTYPE_RULES)
    if (result.kind !== 'rebuilt') throw new Error(`Expected rebuild, got ${result.kind}`)
    expect(manualOf(result.scheme)).toEqual(before.placements)
    expect(result.changes.added).toEqual(
      expect.arrayContaining(['первая ступень 3.24 слева', 'скорость в зоне справа']),
    )
    expect(result.message).toContain('Изменённых вручную объектов шаблона')
    expect(new Set(result.scheme.placements.map((placement) => placement.id)).size).toBe(
      result.scheme.placements.length,
    )
  })

  it('reports preserved manual slots even when the generated objects did not change', () => {
    const withLeftEdit = builtWithManualEdits(18, 'two')
    const right = withLeftEdit.placements.find((item) => item.templateSlot === 'post2:R:speed1')!
    const before = movePlacement(withLeftEdit, right.id, 5, 0)
    const next = withParameters(before, { speedStagesKmh: [60, 50, 40] })
    const result = autoRebuildTemplate(before, next, PROTOTYPE_RULES)
    if (result.kind !== 'rebuilt') throw new Error(`Expected notice, got ${result.kind}`)
    expect(result.changes).toEqual({
      changed: [],
      added: [],
      removed: [],
      keptSlots: 2,
      staleSlots: 0,
    })
    expect(result.scheme.placements).toEqual(before.placements)
    expect(result.scheme.nextPlacementId).toBe(before.nextPlacementId)
    expect(result.scheme.parameters.speedStagesKmh).toEqual([60, 50, 40])
    expect(result.message).toContain(
      'Типовые объекты проверены по новым параметрам: изменений нет.',
    )
    expect(result.message).toContain('оставленных без замены: 2 — проверьте')
  })

  it('keeps the previous objects and explains why when the new parameters cannot be built', () => {
    const before = rebuildTemplatePlacements(example(18, 'out', 'two')).scheme
    // Знаки 2.6/2.7 с отводом 10 м: шаблон не собирается до отвода по табл. И.1.
    const next = withParameters(before, {
      regulation: { ...before.parameters.regulation, mode: 'signs' },
    })
    const result = autoRebuildTemplate(before, next, PROTOTYPE_RULES)
    expect(result.kind).toBe('failed')
    if (result.kind !== 'failed') return
    expect(result.message).toContain('Правки применены, но типовые объекты не перестроены')
    expect(result.message).toContain('отгон 15 м')
  })

  it('names template objects in Russian', () => {
    const built = rebuildTemplatePlacements(example(18, 'out', 'two')).scheme
    const titles = built.placements.map(slotTitle)
    expect(titles).toEqual(
      expect.arrayContaining([
        'знак 1.25 слева',
        'первая ступень 3.24 справа',
        'конец ограничений слева',
        'регулировщик',
        'переносной комплекс',
        'автомобиль прикрытия',
      ]),
    )
    expect(
      describeTemplateChanges({ changed: [], added: [], removed: [], keptSlots: 0, staleSlots: 0 }),
    ).toBe(
      'Типовые объекты проверены по новым параметрам: изменений нет. Ручные объекты сохранены.',
    )
  })
})
