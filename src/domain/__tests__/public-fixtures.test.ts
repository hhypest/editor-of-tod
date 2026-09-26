import { describe, expect, it } from 'vitest'
import b34Source from '../../../tests/fixtures/legacy-b34-manual.json?raw'
import b33Source from '../../../tests/fixtures/manual-v1.json?raw'
import { exportSchemeJson, importSchemeJson } from '../import'

const id = '55740b36-080a-4cbe-9476-e71ffb1ab47f'
const now = '2026-09-26T12:00:00.000Z'

describe('public examples for manual migration checks', () => {
  it('opens the B.33 sample and preserves its source across a v3 roundtrip', () => {
    const original = b33Source
    const imported = importSchemeJson(original, { id, now })

    expect(imported.format).toBe('legacy-v1')
    expect(imported.scheme.crossing.referenceId).toBe('TEST-001')
    expect(imported.scheme.template.code).toBe('b33')
    expect(imported.scheme.placements.map((placement) => placement.id)).toEqual([1, 2])
    expect(imported.scheme.placements[1]).toMatchObject({
      kind: 'element',
      generatedByTemplate: false,
      text: 'Ручная правка',
      position: { anchor: 'abs', offsetXSvg: 810, ySvg: 605 },
    })
    expect(imported.warnings.join(' ')).toContain('d50')
    expect(imported.scheme.source).toMatchObject({ originalJson: original })
    expect(importSchemeJson(exportSchemeJson(imported.scheme)).scheme).toEqual(imported.scheme)
  })

  it('opens the B.34 sample without losing manually moved objects or unknown legacy fields', () => {
    const original = b34Source
    const imported = importSchemeJson(original, { id, now })

    expect(imported.format).toBe('legacy-v1')
    expect(imported.scheme.crossing).toMatchObject({ referenceId: 'TEST-002', snapshot: null })
    expect(imported.scheme.template.code).toBe('b34')
    expect(imported.scheme.parameters.signDistancesMetres.d300).toBe(300.5)
    expect(imported.scheme.parameters.workZones.b34?.workMetres).toBe(18)
    expect(imported.scheme.placements.map((placement) => placement.id)).toEqual([4, 7, 10, 11])
    expect(imported.scheme.placements[0]).toMatchObject({
      kind: 'sign-post',
      generatedByTemplate: true,
      side: 'up',
      position: { anchor: 'L1', offsetXSvg: 125, offsetYSvg: -30 },
    })
    expect(imported.scheme.placements[1]).toMatchObject({
      kind: 'sign-post',
      generatedByTemplate: false,
      signIds: ['3.24_40_ж', '9.99'],
      side: 'down',
      position: { anchor: 'abs', offsetXSvg: 912, offsetYSvg: 44 },
    })
    expect(imported.scheme.placements[2]).toMatchObject({
      kind: 'element',
      generatedByTemplate: false,
      text: 'Ручная надпись',
      position: { anchor: 'Z1', offsetXSvg: -25, ySvg: 600 },
    })
    expect(imported.scheme.nextPlacementId).toBe(12)
    expect(imported.warnings.join(' ')).toContain('Счётчик')
    expect(imported.scheme.source).toMatchObject({ originalJson: original })
    if (imported.scheme.source.kind !== 'legacy-html-v1') throw new Error('Missing original')
    expect(JSON.parse(imported.scheme.source.originalJson)).toHaveProperty(
      'legacyNote.purpose',
      'Проверка сохранения неизвестных полей',
    )
    expect(importSchemeJson(exportSchemeJson(imported.scheme)).scheme).toEqual(imported.scheme)
  })
})
