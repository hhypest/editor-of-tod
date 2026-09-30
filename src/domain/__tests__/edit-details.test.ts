import { describe, expect, it } from 'vitest'
import { reactive } from 'vue'
import fixture from '../../../tests/fixtures/manual-v1.json?raw'
import { applySchemeDetails, createSchemeDetailsDraft, SchemeEditError } from '../edit-details'
import { exportSchemeJson, importSchemeJson } from '../import'
import { detailsDraftSchema } from '../recovery'

const source = importSchemeJson(fixture, {
  id: '55740b36-080a-4cbe-9476-e71ffb1ab47f',
  now: '2026-09-26T12:00:00.000Z',
}).scheme

describe('editing imported project details', () => {
  it('opens and applies a Vue reactive project and form without cloning a Proxy', () => {
    const reactiveScheme = reactive(source)
    const draft = reactive(createSchemeDetailsDraft(reactiveScheme))
    draft.titleBlock.developer.name = 'Новый составитель'
    const updated = applySchemeDetails(reactiveScheme, draft)
    expect(updated.titleBlock.developer.name).toBe('Новый составитель')
    expect(source.titleBlock.developer.name).not.toBe('Новый составитель')
  })
  it('applies text and decimal fields without changing the original, placements or identity', () => {
    const draft = createSchemeDetailsDraft(source)
    draft.parameters.locationText = 'Новый учебный участок'
    draft.parameters.signDistancesMetres.d50 = '50,5'
    draft.parameters.workZones.b34!.workMetres = '18.5'
    draft.parameters.yellowTemporarySigns = false
    draft.titleBlock.work.description = 'Пробная работа'
    const updated = applySchemeDetails(source, draft)

    expect(updated.id).toBe(source.id)
    expect(updated.createdAt).toBe(source.createdAt)
    expect(updated.source).toEqual(source.source)
    expect(updated.placements).toEqual(source.placements)
    expect(updated.parameters.signDistancesMetres.d50).toBe(50.5)
    expect(updated.parameters.workZones.b34?.workMetres).toBe(18.5)
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
    draft.parameters.workZones.b33!.workMetres = '0'
    expect(() => applySchemeDetails(source, draft)).toThrow('Б.33: фронт работ')
    expect(source.parameters.workZones.b33?.workMetres).toBeGreaterThan(0)
  })

  it('validates text length before allowing an export', () => {
    const draft = createSchemeDetailsDraft(source)
    draft.titleBlock.work.description = 'x'.repeat(5_001)
    expect(() => applySchemeDetails(source, draft)).toThrow('titleBlock.work.description')
  })
})

describe('title block v6 in the details form', () => {
  it('rejects an incomplete phone and keeps one or two responsible persons', () => {
    const scheme = importSchemeJson(fixture).scheme
    const draft = createSchemeDetailsDraft(scheme)
    draft.titleBlock.responsible = [
      { position: 'мастер', name: 'Учебный А.Б.', phone: '+7 (910) 12' },
    ]
    expect(() => applySchemeDetails(scheme, draft)).toThrow('Телефон ответственного № 1')
    draft.titleBlock.responsible[0]!.phone = '+7 (910) 123-45-67'
    draft.titleBlock.developer.position = 'инженер'
    const one = applySchemeDetails(scheme, draft)
    expect(one.titleBlock.responsible).toHaveLength(1)
    expect(one.titleBlock.developer.position).toBe('инженер')
    const two = createSchemeDetailsDraft(one)
    two.titleBlock.responsible = [
      two.titleBlock.responsible[0]!,
      { position: '', name: 'Второй Учебный', phone: '' },
    ]
    expect(applySchemeDetails(one, two).titleBlock.responsible).toHaveLength(2)
  })

  it('upgrades an unapplied v5 title block from a recovery copy', () => {
    const scheme = importSchemeJson(fixture).scheme
    const draft = JSON.parse(JSON.stringify(createSchemeDetailsDraft(scheme)))
    draft.titleBlock = {
      developer: { organization: 'Учебная', name: 'Учебный', date: '' },
      work: { organization: '', description: '', period: '' },
      responsible: ['мастер Учебный Иван Петрович', 'Второй Б.В.'],
      approver: { position: '', organization: '', name: '' },
      agreement: { position: '', name: '', year: '' },
    }
    const parsed = detailsDraftSchema.parse(draft)
    expect(parsed.titleBlock.developer.position).toBe('')
    expect(parsed.titleBlock.responsible).toEqual([
      { position: 'мастер', name: 'Учебный Иван Петрович', phone: '' },
      { position: '', name: 'Второй Б.В.', phone: '' },
    ])
  })
})
