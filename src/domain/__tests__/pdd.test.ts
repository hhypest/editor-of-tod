import { describe, expect, it } from 'vitest'
import { identifyDocument } from '../document-identification'
import {
  documentStatuses,
  kindForCode,
  normalizeDocumentCode,
  suggestFromFilename,
  type DocumentRecord,
} from '../normative-documents'
import {
  parameterDefinition,
  PDD_OUTSIDE_SPEED_KEYS,
  PROTOTYPE_RULES,
  rulesFrom,
  suggestValue,
  valueProblem,
  type ParameterState,
} from '../normative-parameters'
import { pddSpeedReference } from '../pdd-speed'
import { pddFindings } from '../pdd-review'
import { importSchemeJson, exportSchemeJson } from '../import'
import { findingFingerprint, markState, setMark } from '../review-marks'
import fixture from '../../../tests/fixtures/legacy-b34-manual.json?raw'

const heading =
  'Постановление Правительства РФ от 23.10.1993 N 1090\n(ред. от 28.08.2026)\nО Правилах дорожного движения'
const current = { id: 1, label: 'ПДД-2030-04-01', sha256: 'a'.repeat(64) }
const rules = { ...PROTOTYPE_RULES, pddDocument: current }

function doc(edition: string, effectiveFrom: string, id: number): DocumentRecord {
  return {
    id,
    code: 'ПДД',
    edition,
    effectiveFrom,
    kind: 'rules',
    title: '',
    amendsId: null,
    note: '',
    actualCheckedAt: '',
    filename: 'synthetic.pdf',
    sha256: 'a'.repeat(64),
    sizeBytes: 1,
    addedAt: '2030-01-01',
  }
}

describe('PDD edition and conditional speed references', () => {
  it('identifies resolution 1090 and the explicit edition, without using the 1993 date', () => {
    const result = identifyDocument([heading], 'скан.pdf')
    expect(result.status).toBe('identified')
    expect(result.candidates[0]).toMatchObject({
      code: 'ПДД',
      edition: '2026-08-28',
      kind: 'rules',
      page: 1,
    })
    expect(
      identifyDocument([heading.replace('(ред. от 28.08.2026)', '')], 'x.pdf').candidates[0]
        ?.edition,
    ).toBe('')
    expect(
      identifyDocument([heading.replace('28.08.2026', '31.02.2026')], 'x.pdf').candidates[0]
        ?.edition,
    ).toBe('')
  })
  it('does not identify a changing resolution or a reference as a base PDD edition', () => {
    expect(
      identifyDocument(
        [
          'Постановление от 28.08.2026 N 1088\nО внесении изменения в постановление от 23 октября 1993 г. N 1090 О Правилах дорожного движения',
        ],
        'x.pdf',
      ).status,
    ).toBe('unrecognized')
    expect(identifyDocument(['Нормативные ссылки\n' + heading], 'x.pdf').status).toBe(
      'unrecognized',
    )
  })
  it('treats the filename as a suggestion and reports an edition conflict', () => {
    expect(suggestFromFilename('PDD-2026-08-28.pdf')).toEqual({
      code: 'ПДД',
      edition: '2026-08-28',
      kind: 'rules',
    })
    expect(identifyDocument([heading], 'ПДД-2025-01-01.pdf').filenameConflict).toBe(true)
    expect(normalizeDocumentCode('пдд рф')).toBe('ПДД')
    expect(kindForCode('ПДД № 1090')).toBe('rules')
  })
  it('requires the effective date independently of the edition date or year', () => {
    const undated = doc('1993', '', 1)
    expect(documentStatuses([undated], '2030-06-01').get(1)).toEqual({ kind: 'undated' })
    const old = doc('2029-05-01', '2029-09-01', 2)
    const next = doc('2030-04-01', '2030-09-01', 3)
    expect(documentStatuses([old, next], '2030-06-01').get(2)?.kind).toBe('current')
    expect(documentStatuses([old, next], '2030-06-01').get(3)?.kind).toBe('future')
    expect(documentStatuses([old, next], '2030-10-01').get(2)?.kind).toBe('superseded')
    expect(documentStatuses([old, next], '2030-10-01').get(3)?.kind).toBe('current')
  })
  it.each(['2030', 'Учебное изменение'])(
    'requires a date for a PDD-linked resolution with edition %s',
    (edition) => {
      const base = doc('2029-05-01', '2029-09-01', 1)
      const amendment = { ...doc(edition, '', 2), code: 'Постановление № 1088', amendsId: base.id }
      for (const [effectiveFrom, inForce] of [
        ['', false],
        ['2030-09-01', false],
        ['2030-06-01', true],
      ] as const) {
        expect(
          documentStatuses([base, { ...amendment, effectiveFrom }], '2030-06-01').get(2),
        ).toEqual({ kind: 'amendment', of: base.id, inForce })
      }
      // Поведение недатированных изменений других нормативов сохраняется.
      expect(
        documentStatuses([{ ...base, code: 'ГОСТ Р 52289' }, amendment], '2030-06-01').get(2),
      ).toEqual({ kind: 'amendment', of: base.id, inForce: true })
    },
  )
  it('uses the same light-vehicle value, source and confirmation as project defaults despite a conflicting table row', () => {
    const table = parameterDefinition('pdd-speed-outside-conditions')!
    if (table.type !== 'table') throw new Error('Expected table')
    const state = (id: string, value: number | Record<string, string>): ParameterState => ({
      id,
      status: { kind: 'confirmed' },
      document: current,
      quote: null,
      suggestion: null,
      amendments: [],
      confirmation: {
        id: 1,
        parameterId: id,
        documentId: current.id,
        documentLabel: current.label,
        clause: 'п. 10.3',
        page: 1,
        quote: '',
        fragment: '',
        value,
        confirmedBy: 'Учебный составитель',
        confirmedAt: '2030-05-01',
        note: 'Учебная сверка',
      },
    })
    const tableState = state(table.id, {
      ...table.fallback,
      [PDD_OUTSIDE_SPEED_KEYS.lightOrdinary]: '92',
    })
    const scalarState = state('pdd-speed-outside', 87)
    const confirmed = rulesFrom([tableState, scalarState])
    expect(confirmed.pddSpeedLimits.outside.lightOrdinary).toBe(confirmed.allowedSpeedKmh.out)
    expect(pddSpeedReference('out', 'ordinary', 'light', confirmed)).toMatchObject({
      speed: 87,
      source: confirmed.sources['pdd-speed-outside'],
      confirmed: true,
    })
    const tableOnly = rulesFrom([tableState])
    expect(pddSpeedReference('out', 'ordinary', 'light', tableOnly)).toMatchObject({
      speed: tableOnly.allowedSpeedKmh.out,
      confirmed: false,
    })
    const scalarOnly = rulesFrom([scalarState])
    expect(pddSpeedReference('out', 'ordinary', 'light', scalarOnly)?.confirmed).toBe(true)
    expect(pddSpeedReference('out', 'motorway', 'light', scalarOnly)?.confirmed).toBe(false)
    const towing = {
      ...confirmed,
      pddSpeedLimits: { ...confirmed.pddSpeedLimits, towing: 100 },
      confirmed: { ...confirmed.confirmed, 'pdd-speed-towing': true },
    }
    expect(pddSpeedReference('out', 'ordinary', 'towing', towing)).toMatchObject({
      speed: 87,
      confirmed: true,
    })
  })
  it.each([
    ['light', 'ordinary', 90],
    ['light', 'motorway', 110],
    ['heavy', 'ordinary', 70],
    ['heavy', 'motorway', 90],
    ['busSeated', 'ordinary', 90],
    ['busOther', 'ordinary', 70],
    ['children', 'ordinary', 60],
    ['peopleTruck', 'ordinary', 60],
    ['towing', 'ordinary', 50],
  ] as const)('uses the selected vehicle %s and road %s: %i', (vehicle, road, speed) => {
    expect(pddSpeedReference('out', road, vehicle, rules)).toMatchObject({
      speed,
      confirmed: false,
      applicable: road !== 'motorway',
    })
  })
  it('keeps unknown conditions and special permits without an automatic value', () => {
    expect(pddSpeedReference('auto', 'ordinary', 'light', rules)).toBeNull()
    expect(pddSpeedReference('out', '', 'light', rules)).toBeNull()
    expect(pddSpeedReference('out', 'ordinary', '', rules)).toBeNull()
    expect(pddSpeedReference('out', 'ordinary', 'permit', rules)).toBeNull()
    expect(pddSpeedReference('in', 'motorway', 'light', rules)).toBeNull()
    expect(pddSpeedReference('in', 'ordinary', 'heavy', rules)?.speed).toBe(60)
    expect(pddSpeedReference('in', 'residential', 'towing', rules)?.speed).toBe(20)
  })
  it('uses confirmed parameter values rather than code constants', () => {
    const changed = {
      ...rules,
      pddSpeedLimits: {
        ...rules.pddSpeedLimits,
        outside: { ...rules.pddSpeedLimits.outside, heavyOrdinary: 68 },
      },
      confirmed: { 'pdd-speed-outside-conditions': true },
    }
    expect(pddSpeedReference('out', 'ordinary', 'heavy', changed)).toMatchObject({
      speed: 68,
      confirmed: true,
    })
    expect(pddSpeedReference('out', 'ordinary', 'towing', changed)?.confirmed).toBe(false)
  })
  it('requires all named speed conditions and rejects missing, renamed, extra and invalid rows', () => {
    const definition = parameterDefinition('pdd-speed-outside-conditions')!
    if (definition.type !== 'table') throw new Error('Expected table')
    expect(valueProblem(definition, definition.fallback)).toBeNull()
    const partial = { ...definition.fallback }
    delete partial[PDD_OUTSIDE_SPEED_KEYS.heavyOrdinary]
    expect(valueProblem(definition, partial)).not.toBeNull()
    expect(valueProblem(definition, { ...definition.fallback, extra: '90' })).not.toBeNull()
    expect(
      valueProblem(definition, {
        ...definition.fallback,
        [PDD_OUTSIDE_SPEED_KEYS.heavyOrdinary]: '0',
      }),
    ).not.toBeNull()
  })
  it('does not extract another vehicle limit as the light-vehicle preview', () => {
    const definition = parameterDefinition('pdd-speed-outside')!
    expect(
      suggestValue(definition, {
        text: 'Учебная строка грузовых свыше 3,5 т: на остальных дорогах — не более 69 км/ч;',
      }),
    ).toBeNull()
    expect(
      suggestValue(definition, {
        text: 'Учебный пример: мотоциклам, легковым автомобилям и грузовым автомобилям в заданной группе на остальных дорогах — не более 89 км/ч;',
      }),
    ).toBe(89)
  })
})

describe('PDD review evidence', () => {
  it.each(['add', 'remove', 'speed', 'cancel', 'move', 'plate'] as const)(
    'invalidates a speed mark after a sign post change: %s',
    (change) => {
      let scheme = importSchemeJson(fixture).scheme
      const original = pddFindings(scheme, rules)
      scheme = setMark(scheme, original, 'pdd-speed', true, '2030-05-01T00:00:00.000Z')
      const post = scheme.placements.find(
        (item) => item.kind === 'sign-post' && item.signIds.includes('3.24_40_ж'),
      )!
      if (post.kind !== 'sign-post') throw new Error('Expected sign post')
      if (change === 'add')
        scheme.placements.push({ ...post, id: scheme.nextPlacementId++, signIds: ['3.25'] })
      else if (change === 'remove')
        scheme.placements = scheme.placements.filter((item) => item.id !== post.id)
      else if (change === 'speed') post.signIds = ['3.24_30_ж']
      else if (change === 'cancel') post.signIds = ['3.25']
      else if (change === 'move') post.position.offsetXSvg += 10
      else post.signIds.push('8.2.1')
      expect(markState(scheme, pddFindings(scheme, rules)[0]!).status).toBe('stale')
    },
  )
  it('retains the speed mark when only an unrelated text element changes', () => {
    let scheme = importSchemeJson(fixture).scheme
    scheme = setMark(
      scheme,
      pddFindings(scheme, rules),
      'pdd-speed',
      true,
      '2030-05-01T00:00:00.000Z',
    )
    const text = scheme.placements.find(
      (item) => item.kind === 'element' && item.elementKind === 'text',
    )!
    if (text.kind !== 'element') throw new Error('Expected text element')
    text.text = 'Другая учебная надпись'
    expect(markState(scheme, pddFindings(scheme, rules)[0]!).status).toBe('marked')
  })
  it('blocks marks without an in-force library edition and includes conditional checks', () => {
    const scheme = importSchemeJson(fixture).scheme
    const unavailable = pddFindings(scheme, PROTOTYPE_RULES)
    expect(unavailable.every((finding) => finding.markBlocked)).toBe(true)
    expect(pddFindings(scheme, rules).every((finding) => !finding.markBlocked)).toBe(true)
    scheme.parameters.regulation.mode = 'two'
    expect(pddFindings(scheme, rules).map((finding) => finding.id)).toContain('pdd-regulator')
    scheme.parameters.regulation.mode = 'signs'
    scheme.placements = []
    expect(pddFindings(scheme, rules).map((finding) => finding.id)).toEqual([
      'pdd-speed',
      'pdd-crossing',
    ])
  })
  it('invalidates marks after changes to edition, amendments and scheme conditions, retaining graphics on round trip', () => {
    let scheme = importSchemeJson(fixture).scheme
    const initial = pddFindings(scheme, rules)
    scheme = setMark(scheme, initial, 'pdd-speed', true, '2030-05-01T00:00:00.000Z')
    const changed = { ...rules, pddDocument: { ...current, sha256: 'b'.repeat(64) } }
    expect(markState(scheme, pddFindings(scheme, changed)[0]!).status).toBe('stale')
    const amendment = {
      ...rules,
      evidence: { ...rules.evidence, 'pdd-speed-settlement': 'Учебное изменение к п. 6.15' },
    }
    expect(markState(scheme, pddFindings(scheme, amendment)[0]!).status).toBe('stale')
    scheme.parameters.approachSpeedKmh = 70
    expect(markState(scheme, pddFindings(scheme, rules)[0]!).status).toBe('stale')
    const again = importSchemeJson(exportSchemeJson(scheme)).scheme
    expect(again.placements).toEqual(scheme.placements)
    expect(findingFingerprint(pddFindings(again, rules)[0]!)).toBe(
      findingFingerprint(pddFindings(scheme, rules)[0]!),
    )
  })
})
