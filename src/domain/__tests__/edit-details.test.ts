import { describe, expect, it } from 'vitest'
import fixture from '../../../tests/fixtures/manual-v1.json?raw'
import { applySchemeDetails, createSchemeDetailsDraft, SchemeEditError } from '../edit-details'
import { exportSchemeJson, importSchemeJson } from '../import'

const source = importSchemeJson(fixture, {
  id: '55740b36-080a-4cbe-9476-e71ffb1ab47f',
  now: '2026-09-26T12:00:00.000Z',
}).scheme

describe('editing imported project details', () => {
  it('applies text and decimal fields without changing the original, placements or identity', () => {
    const draft = createSchemeDetailsDraft(source)
    draft.parameters.locationText = 'Новый учебный участок'
    draft.parameters.signDistancesMetres.d50 = '50,5'
    draft.parameters.workZones.b34.workMetres = '18.5'
    draft.parameters.yellowTemporarySigns = false
    draft.titleBlock.work.description = 'Пробная работа'
    const updated = applySchemeDetails(source, draft)

    expect(updated.id).toBe(source.id)
    expect(updated.createdAt).toBe(source.createdAt)
    expect(updated.source).toEqual(source.source)
    expect(updated.placements).toEqual(source.placements)
    expect(updated.parameters.signDistancesMetres.d50).toBe(50.5)
    expect(updated.parameters.workZones.b34.workMetres).toBe(18.5)
    expect(updated.titleBlock.work.description).toBe('Пробная работа')
    expect(source.parameters.signDistancesMetres.d50).toBeNull()
    expect(source.titleBlock.work.description).not.toBe('Пробная работа')
    expect(importSchemeJson(exportSchemeJson(updated)).scheme).toEqual(updated)
  })

  it('isolates draft changes and accepts an empty optional distance', () => {
    const draft = createSchemeDetailsDraft(source)
    draft.titleBlock.developer.name = 'Временное имя'
    draft.parameters.signDistancesMetres.d300 = ''
    expect(source.titleBlock.developer.name).not.toBe('Временное имя')
    expect(applySchemeDetails(source, draft).parameters.signDistancesMetres.d300).toBeNull()
  })

  it('rejects negative, invalid and missing numbers without changing the project', () => {
    for (const [field, value] of [
      ['d300', '-1'],
      ['d300', 'триста'],
    ] as const) {
      const draft = createSchemeDetailsDraft(source)
      draft.parameters.signDistancesMetres[field] = value
      expect(() => applySchemeDetails(source, draft)).toThrowError(SchemeEditError)
    }
    const draft = createSchemeDetailsDraft(source)
    draft.parameters.speedStagesKmh[0] = ''
    expect(() => applySchemeDetails(source, draft)).toThrow('первая ступень скорости')
    draft.parameters.speedStagesKmh[0] = '70'
    draft.parameters.workZones.b33.workMetres = '0'
    expect(() => applySchemeDetails(source, draft)).toThrow('Б.33: фронт работ')
    expect(source.parameters.workZones.b33.workMetres).toBeGreaterThan(0)
  })

  it('validates text length before allowing an export', () => {
    const draft = createSchemeDetailsDraft(source)
    draft.titleBlock.work.description = 'x'.repeat(5_001)
    expect(() => applySchemeDetails(source, draft)).toThrow('titleBlock.work.description')
  })
})
