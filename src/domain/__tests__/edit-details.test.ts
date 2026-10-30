import { describe, expect, it } from 'vitest'
import { reactive } from 'vue'
import fixture from '../../../tests/fixtures/manual-v1.json?raw'
import {
  applySchemeDetails,
  createSchemeDetailsDraft,
  SchemeEditError,
  switchTemplateToRule,
  templateByRule,
} from '../edit-details'
import { createUnlinkedScheme } from '../create-scheme'
import { PROTOTYPE_RULES } from '../normative-parameters'
import { reviewScheme } from '../review-scheme'
import { setMark } from '../review-marks'
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

/** B.33 с фронтом 30 м: так сохранялись проекты при прежнем правиле «30 м и более — Б.33». */
function savedB33At30() {
  const scheme = createUnlinkedScheme(
    {
      referenceId: 'TEST-VARIANT',
      locationText: 'Учебный участок',
      directionLeft: 'А',
      directionRight: 'Б',
      frontMetres: '31',
      taperMetres: '8',
      bufferMetres: '15',
      speedStagesKmh: ['70', '50', '40'],
      location: 'out',
      approachSpeedKmh: '90',
      yellowTemporarySigns: false,
    },
    { id: '55740b36-080a-4cbe-9476-e71ffb1ab47f', now: '2026-10-12T10:00:00.000Z' },
  )
  scheme.parameters.workZones.b33!.workMetres = 30
  return importSchemeJson(exportSchemeJson(scheme)).scheme
}

describe('variant chosen by the configurable front threshold', () => {
  it('keeps a saved variant but blocks further edits of an over-limit front', () => {
    const saved = savedB33At30()
    expect(saved.template.code).toBe('b33')
    const draft = createSchemeDetailsDraft(saved)
    draft.parameters.locationText = 'Другой участок'
    const edited = applySchemeDetails(saved, draft)
    expect(edited.template.code).toBe('b33')
    expect(templateByRule(edited, PROTOTYPE_RULES)).toBe('b34')

    const tooLong = structuredClone(saved)
    tooLong.parameters.workZones.b33!.workMetres = 46
    const other = createSchemeDetailsDraft(tooLong)
    other.parameters.locationText = 'Другой участок'
    expect(() => applySchemeDetails(tooLong, other)).toThrow(
      'наибольший фронт работ на переезде 45 м',
    )
    other.parameters.workZones.b33!.workMetres = '47'
    expect(() => applySchemeDetails(tooLong, other)).toThrow(
      'наибольший фронт работ на переезде 45 м',
    )
  })

  it('re-selects the variant by the threshold when the front changes', () => {
    const saved = savedB33At30()
    const draft = createSchemeDetailsDraft(saved)
    draft.parameters.workZones.b33!.workMetres = '29'
    const edited = applySchemeDetails(saved, draft)
    expect(edited.template.code).toBe('b34')
    expect(edited.parameters.workZones).toMatchObject({ b33: null, b34: { workMetres: 29 } })
    const strict = { ...PROTOTYPE_RULES, b34MaxFrontMetres: 25 }
    expect(applySchemeDetails(saved, draft, strict).template.code).toBe('b33')
  })

  it('switches the variant only on an explicit request and clears earlier marks', () => {
    const saved = savedB33At30()
    const marked = setMark(saved, reviewScheme(saved), 'template', true)
    expect(Object.keys(marked.reviewMarks)).toContain('template')
    const switched = switchTemplateToRule(marked, PROTOTYPE_RULES)
    expect(switched.template).toMatchObject({ code: 'b34', reviewStatus: 'not-verified' })
    expect(switched.parameters.workZones.b33).toBeNull()
    expect(switched.parameters.workZones.b34?.workMetres).toBe(30)
    expect(switched.reviewMarks).toEqual({})
    expect(switched.placements).toEqual(marked.placements)
    expect(marked.template.code).toBe('b33')
    expect(templateByRule(switched, PROTOTYPE_RULES)).toBeNull()
    expect(reviewScheme(switched).some((finding) => finding.id === 'variant-front')).toBe(false)
    expect(switchTemplateToRule(switched, PROTOTYPE_RULES)).toBe(switched)
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
