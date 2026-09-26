import { describe, expect, it } from 'vitest'
import { createNewScheme, SchemeCreationError, type NewSchemeInput } from '../create-scheme'
import { applySchemeDetails, createSchemeDetailsDraft } from '../edit-details'
import { newTextDraft, savePlacement } from '../edit-placements'
import { exportSchemeJson, importSchemeJson } from '../import'

const input: NewSchemeInput = {
  referenceId: 'TEST-NEW',
  locationText: 'Учебный переезд',
  directionLeft: 'Условное А',
  directionRight: 'Условное Б',
  frontMetres: '18,5',
  taperMetres: '8',
  bufferMetres: '12',
  speedStagesKmh: ['70', '50', '40'],
  yellowTemporarySigns: false,
}
const options = {
  id: '55740b36-080a-4cbe-9476-e71ffb1ab47f',
  now: '2026-09-26T12:00:00.000Z',
}

describe('native project creation', () => {
  it('starts B.34 with only entered measurements and supports editing and JSON roundtrip', () => {
    const scheme = createNewScheme(input, options)
    expect(scheme.schemaVersion).toBe(3)
    expect(scheme.crossing).toEqual({
      referenceId: 'TEST-NEW',
      source: 'entered-by-editor',
      snapshot: null,
    })
    expect(scheme.source).toEqual({ kind: 'created-in-editor' })
    expect(scheme.template).toMatchObject({ code: 'b34', reviewStatus: 'not-verified' })
    expect(scheme.parameters.workZones).toEqual({
      b33: null,
      b34: {
        taperMetres: 8,
        bufferMetres: 12,
        workMetres: 18.5,
        labels: { taper: '', buffer: '', work: '' },
      },
    })
    expect(scheme.parameters.signDistancesMetres).toEqual({
      d300: null,
      d250: null,
      d150: null,
      d50: null,
    })
    expect(scheme.placements).toEqual([])
    expect(scheme.nextPlacementId).toBe(1)

    const details = createSchemeDetailsDraft(scheme)
    details.parameters.signDistancesMetres.d50 = '50'
    details.titleBlock.work.description = 'Условная работа'
    const edited = applySchemeDetails(scheme, details)
    const placement = newTextDraft()
    if (placement.kind !== 'element') throw new Error('Expected text placement')
    placement.text = 'Ручная надпись'
    const withText = savePlacement(edited, placement)
    expect(importSchemeJson(exportSchemeJson(withText))).toMatchObject({
      scheme: withText,
      format: 'scheme-v3',
    })
    expect(withText.source).toEqual({ kind: 'created-in-editor' })
    expect(scheme.parameters.signDistancesMetres.d50).toBeNull()
  })

  it('chooses B.33 at 30 m, keeps the inactive variant empty and checks active zone', () => {
    const scheme = createNewScheme({ ...input, frontMetres: '30' }, options)
    expect(scheme.template.code).toBe('b33')
    expect(scheme.parameters.workZones.b34).toBeNull()
    expect(scheme.parameters.workZones.b33?.workMetres).toBe(30)
    const missing = createSchemeDetailsDraft(scheme)
    missing.parameters.workZones.b33 = null
    expect(() => applySchemeDetails(scheme, missing)).toThrow('parameters.workZones.b33')
  })

  it('does not silently keep B.34 after the native work front crosses 30 m', () => {
    const scheme = createNewScheme(input, options)
    const draft = createSchemeDetailsDraft(scheme)
    draft.parameters.workZones.b34!.workMetres = '31'
    expect(() => applySchemeDetails(scheme, draft)).toThrow('workZones.b34.workMetres')
  })

  it.each([
    [{ ...input, referenceId: '  ' }, 'идентификатор'],
    [{ ...input, frontMetres: '0' }, 'фронт'],
    [{ ...input, taperMetres: '-2' }, 'отвод'],
    [{ ...input, bufferMetres: 'неизвестно' }, 'буфер'],
    [{ ...input, speedStagesKmh: ['70', '', '40'] as [string, string, string] }, 'скорость 2'],
  ])('rejects missing or invalid measurements', (bad, field) => {
    expect(() => createNewScheme(bad, options)).toThrow(SchemeCreationError)
    expect(() => createNewScheme(bad, options)).toThrow(field)
  })
})
