import { describe, expect, it } from 'vitest'
import type { LegacyV1 } from '../legacy-v1'
import {
  exportSchemeJson,
  importSchemeJson,
  MAX_PROJECT_FILE_BYTES,
  SchemeImportError,
} from '../import'
import { schemeV2Schema, schemeV3Schema, schemeV5Schema, schemeV6Schema } from '../model'
import { oldSnapshot, v5Snapshot, v6Snapshot } from '../../../tests/fixtures/old-version'

const importedAt = '2026-09-26T12:00:00.000Z'
const id = '55740b36-080a-4cbe-9476-e71ffb1ab47f'

const legacy: LegacyV1 = {
  v: 1,
  params: {
    key: 'TEST-001',
    variant: 'b33',
    peregon: 'Учебный участок',
    dirL: 'лево',
    dirR: 'право',
    d300: '300',
    d250: '250.5',
    d150: 150,
    d50: '',
    s1: 70,
    s2: 50,
    s3: 40,
    yellow: true,
    len: {
      b33: { taper: 7, buffer: 15, zone: 37, lTaper: '5–10', lBuffer: '15', lZone: 'min 30' },
      b34: { taper: 10, buffer: 10, zone: 30, lTaper: '10', lBuffer: '10', lZone: 'max 30' },
    },
  },
  head: {
    dev_org: 'Учебная организация',
    dev_fio: 'Тестовый составитель',
    dev_date: '26.09.2026',
    org: 'Учебная организация',
    work: 'Учебная схема',
    term: 'Условный срок',
    resp1: 'Ответственный 1',
    resp2: 'Ответственный 2',
    ap_pos: 'Должность',
    ap_org: 'Учебный владелец',
    ap_fio: 'Подпись',
    ag_pos: 'Должность',
    ag_fio: 'Подпись',
    year: '2026',
  },
  objects: [
    {
      t: 'post',
      id: 1,
      signs: ['1.25', '3.24_40_ж'],
      anchor: 'L0',
      dx: -520,
      dy: 12,
      side: 'down',
      stand: 'left',
      dist: '{d300}',
      auto: 1,
    },
    {
      t: 'post',
      id: 2,
      signs: ['9.99'],
      anchor: 'abs',
      dx: 800,
      side: 'up',
      stand: 'right',
      dist: null,
    },
    {
      t: 'el',
      id: 3,
      e: 'text',
      anchor: 'abs',
      dx: 810,
      y: 605,
      w: 0,
      h: 0,
      text: 'Ручная правка',
      size: 14,
      bold: true,
    },
    {
      t: 'el',
      id: 4,
      e: 'pit',
      anchor: 'Z0',
      dx: 26,
      y: 490,
      w: 30,
      h: 18,
      auto: 1,
    },
  ],
  nid: 5,
}

function sourceFixture(): LegacyV1 {
  return structuredClone(legacy)
}

describe('import of autonomous editor projects', () => {
  it('preserves manual placements, both work zones and the exact original JSON', () => {
    const source = JSON.stringify(sourceFixture(), null, 1)
    const result = importSchemeJson(source, { id, now: importedAt })

    expect(result.format).toBe('legacy-v1')
    expect(result.scheme.source).toMatchObject({ kind: 'legacy-html-v1', originalJson: source })
    expect(result.scheme.crossing).toMatchObject({ referenceId: 'TEST-001', snapshot: null })
    expect(result.scheme.parameters.signDistancesMetres).toEqual({
      d300: 300,
      d250: 250.5,
      d150: 150,
      d50: null,
      n100: null,
      n50: null,
    })
    expect(result.scheme.parameters.workZones.b34?.workMetres).toBe(30)
    expect(result.scheme.placements[0]).toMatchObject({
      kind: 'sign-post',
      position: { anchor: 'L0', offsetXSvg: -520, offsetYSvg: 12 },
      signIds: ['1.25', '3.24_40_ж'],
      generatedByTemplate: true,
    })
    expect(result.scheme.placements[1]).toMatchObject({
      signIds: ['9.99'],
      generatedByTemplate: false,
    })
    expect(result.scheme.placements[2]).toMatchObject({
      kind: 'element',
      text: 'Ручная правка',
      position: { anchor: 'abs', offsetXSvg: 810, ySvg: 605 },
      generatedByTemplate: false,
    })
    expect(result.warnings.join(' ')).toContain('d50')
  })

  it('exports and re-imports v7 without creating another identity or losing the source', () => {
    const first = importSchemeJson(JSON.stringify(sourceFixture()), { id, now: importedAt })
    const second = importSchemeJson(exportSchemeJson(first.scheme))

    expect(second.format).toBe('scheme-v7')
    expect(second.scheme).toEqual(first.scheme)
    expect(second.scheme.id).toBe(id)
  })

  it('opens v5 files saved before PNG revision pinning was introduced', () => {
    const scheme = importSchemeJson(JSON.stringify(sourceFixture()), { id, now: importedAt }).scheme
    const { signImages: _absentInEarlierV5, ...earlierV5 } = scheme
    const reopened = importSchemeJson(JSON.stringify(earlierV5))
    expect(reopened.scheme).toEqual(scheme)
    expect(reopened.scheme.signImages).toEqual({ catalog: null, revisions: {} })
  })

  it('opens a v6 file: the settlement speed becomes the approach speed', () => {
    const scheme = importSchemeJson(JSON.stringify(sourceFixture()), { id, now: importedAt }).scheme
    const reopened = importSchemeJson(JSON.stringify(schemeV6Schema.parse(v6Snapshot(scheme))))
    expect(reopened.format).toBe('scheme-v6')
    expect(reopened.scheme).toEqual(scheme)
    expect(reopened.scheme.parameters.approachSpeedKmh).toBe(60)
    expect(reopened.warnings.join(' ')).not.toContain('скорость на подходе')

    // Вне населённого пункта прежнее поле не использовалось: скорость не переносится.
    const outside = {
      ...scheme,
      parameters: { ...scheme.parameters, location: 'out' as const, approachSpeedKmh: null },
    }
    const reopenedOutside = importSchemeJson(JSON.stringify(v6Snapshot(outside)))
    expect(reopenedOutside.scheme.parameters.approachSpeedKmh).toBeNull()
    expect(reopenedOutside.warnings.join(' ')).toContain('Разрешённая скорость на подходе')
  })

  it('opens a v5 file with free-text responsible persons and splits them for v6', () => {
    const scheme = importSchemeJson(JSON.stringify(sourceFixture()), { id, now: importedAt }).scheme
    const v5 = {
      ...v5Snapshot(scheme),
      titleBlock: {
        ...v5Snapshot(scheme).titleBlock,
        responsible: ['начальник участка Учебный Иван Петрович, тел. 8 910 000-11-22', ''] as [
          string,
          string,
        ],
      },
    }
    const reopened = importSchemeJson(JSON.stringify(schemeV5Schema.parse(v5)))
    expect(reopened.format).toBe('scheme-v5')
    expect(reopened.scheme.schemaVersion).toBe(7)
    expect(reopened.scheme.titleBlock.responsible).toEqual([
      { position: 'начальник участка', name: 'Учебный Иван Петрович', phone: '+7 (910) 000-11-22' },
    ])
    expect(reopened.scheme.titleBlock.developer.position).toBe('')
    expect(reopened.scheme.reviewMarks).toEqual({})
    expect(reopened.warnings.join(' ')).toContain('Ответственные разделены')
    // Прежний снимок без изменений открывается в тот же проект v6.
    expect(importSchemeJson(JSON.stringify(v5Snapshot(scheme))).scheme).toEqual(scheme)
  })

  it('accepts a saved v2 file and upgrades it without losing legacy fields or identity', () => {
    const migrated = importSchemeJson(JSON.stringify(sourceFixture()), {
      id,
      now: importedAt,
    }).scheme
    const v2 = schemeV2Schema.parse(oldSnapshot(migrated, 2))
    const reopened = importSchemeJson(JSON.stringify(v2))
    expect(reopened.format).toBe('scheme-v2')
    expect(reopened.scheme).toEqual(migrated)
    expect(reopened.scheme.source).toMatchObject({
      originalJson: migrated.source.kind === 'legacy-html-v1' ? migrated.source.originalJson : '',
    })
    expect(JSON.parse(exportSchemeJson(reopened.scheme)).schemaVersion).toBe(7)
  })

  it('opens the previous v3 format and writes the same data in v7', () => {
    const migrated = importSchemeJson(JSON.stringify(sourceFixture()), {
      id,
      now: importedAt,
    }).scheme
    const v3 = schemeV3Schema.parse(oldSnapshot(migrated, 3))
    const reopened = importSchemeJson(JSON.stringify(v3))
    expect(reopened.format).toBe('scheme-v3')
    expect(reopened.scheme).toEqual(migrated)
    expect(JSON.parse(exportSchemeJson(reopened.scheme)).schemaVersion).toBe(7)
  })

  it('keeps unknown old fields in the original snapshot', () => {
    const withExtra = { ...sourceFixture(), futureLegacyField: { note: 'сохранить' } }
    const imported = importSchemeJson(JSON.stringify(withExtra), { id, now: importedAt })
    if (imported.scheme.source.kind !== 'legacy-html-v1') throw new Error('Missing original')
    expect(JSON.parse(imported.scheme.source.originalJson)).toHaveProperty(
      'futureLegacyField.note',
      'сохранить',
    )
  })

  it('corrects a stale object counter but does not change existing object IDs', () => {
    const input = sourceFixture()
    input.nid = 2
    const result = importSchemeJson(JSON.stringify(input), { id, now: importedAt })
    expect(result.scheme.nextPlacementId).toBe(5)
    expect(result.scheme.placements.map((object) => object.id)).toEqual([1, 2, 3, 4])
    expect(result.warnings.join(' ')).toContain('Счётчик')
  })

  it('rejects conflicting object identities in a saved project', () => {
    const scheme = importSchemeJson(JSON.stringify(sourceFixture()), { id, now: importedAt }).scheme
    const duplicate = structuredClone(scheme)
    duplicate.placements[1]!.id = duplicate.placements[0]!.id
    expect(() => importSchemeJson(JSON.stringify(duplicate))).toThrowError(
      expect.objectContaining({ code: 'invalid-data', field: 'placements.1.id' }),
    )

    const staleCounter = structuredClone(scheme)
    staleCounter.nextPlacementId = 1
    expect(() => importSchemeJson(JSON.stringify(staleCounter))).toThrowError(
      expect.objectContaining({ code: 'invalid-data', field: 'nextPlacementId' }),
    )
  })

  it('rejects duplicate object IDs with a field path', () => {
    const input = sourceFixture()
    input.objects[1]!.id = 1
    expect(() => importSchemeJson(JSON.stringify(input))).toThrowError(
      expect.objectContaining({ code: 'invalid-data', field: 'objects.1.id' }),
    )
  })

  it('rejects a malformed distance instead of silently replacing it', () => {
    const input = sourceFixture()
    input.params.d150 = 'около 150'
    expect(() => importSchemeJson(JSON.stringify(input))).toThrowError(
      expect.objectContaining({ code: 'invalid-data', field: 'params.d150' }),
    )
  })

  it('rejects malformed and unsupported files', () => {
    expect(() => importSchemeJson('{')).toThrowError(SchemeImportError)
    expect(() => importSchemeJson(JSON.stringify({ v: 7 }))).toThrowError(
      expect.objectContaining({ code: 'unsupported-version' }),
    )
    const incomplete = sourceFixture()
    delete (incomplete.head as Partial<LegacyV1['head']>).org
    expect(() => importSchemeJson(JSON.stringify(incomplete))).toThrowError(
      expect.objectContaining({ code: 'invalid-data', field: 'head.org' }),
    )
  })

  it('rejects an oversized input before parsing', () => {
    expect(() => importSchemeJson(' '.repeat(MAX_PROJECT_FILE_BYTES + 1))).toThrowError(
      expect.objectContaining({ code: 'too-large' }),
    )
  })
})

describe('legacy v1 regulation', () => {
  const withRegulation = (reg: Record<string, unknown>) =>
    JSON.stringify({ ...legacy, params: { ...legacy.params, variant: 'b34', reg } })
  const base = { mode: 'signs', hourly: '120', k: 0.1, straight: true, last: null }

  it('turns «visibility ensured» into the inverted «visibility restricted» flag', () => {
    const ensured = importSchemeJson(withRegulation({ ...base, vis: true }), {
      id,
      now: importedAt,
    })
    expect(ensured.scheme.parameters.regulation).toMatchObject({ vis: false, mode: 'signs' })
    const restricted = importSchemeJson(withRegulation({ ...base, vis: false }), {
      id,
      now: importedAt,
    })
    expect(restricted.scheme.parameters.regulation.vis).toBe(true)
  })

  it('reports an unknown regulation key instead of rejecting the file', () => {
    const result = importSchemeJson(withRegulation({ ...base, vis: true, extra: 1 }), {
      id,
      now: importedAt,
    })
    expect(result.scheme.parameters.regulation).not.toHaveProperty('extra')
    expect(result.warnings.join('\n')).toContain('params.reg.extra')
  })
})
