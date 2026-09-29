import { describe, expect, it } from 'vitest'
import {
  actualityCheckDue,
  catalogEditionStatus,
  currentDocument,
  documentStatuses,
  normalizeDocumentCode,
  suggestFromFilename,
  type DocumentRecord,
} from '../normative-documents'

let nextId = 1
function doc(partial: Partial<DocumentRecord> & Pick<DocumentRecord, 'code' | 'edition'>) {
  return {
    id: nextId++,
    title: '',
    kind: 'signs' as const,
    effectiveFrom: '',
    amendsId: null,
    note: '',
    actualCheckedAt: '',
    filename: 'x.pdf',
    sha256: 'a'.repeat(64),
    sizeBytes: 1,
    addedAt: '2026-09-29T00:00:00.000Z',
    ...partial,
  } satisfies DocumentRecord
}

describe('normative document library', () => {
  it('normalizes document codes and keeps the edition separate', () => {
    expect(normalizeDocumentCode('гост р52290-2024')).toBe('ГОСТ Р 52290')
    expect(normalizeDocumentCode('ГОСТ  Р 52289-2019')).toBe('ГОСТ Р 52289')
    expect(normalizeDocumentCode('одм 218.6.019-2016')).toBe('ОДМ 218.6.019')
  })

  it('suggests code, edition and kind from typical file names', () => {
    expect(suggestFromFilename('GOST-R-52290-2024.pdf')).toEqual({
      code: 'ГОСТ Р 52290',
      edition: '2024',
      kind: 'signs',
    })
    expect(suggestFromFilename('GOSTR52289-2019.pdf')).toEqual({
      code: 'ГОСТ Р 52289',
      edition: '2019',
      kind: 'rules',
    })
    // Опечатка в годе не превращается в редакцию: составитель укажет её сам.
    expect(suggestFromFilename('odm-218.6.019-216.pdf')).toEqual({
      code: 'ОДМ 218.6.019',
      edition: '',
      kind: 'methodology',
    })
    expect(suggestFromFilename('скан.pdf')).toEqual({ code: '', edition: '', kind: 'other' })
  })

  it('marks the latest edition in force as current and earlier ones as superseded', () => {
    const old = doc({ code: 'ГОСТ Р 52290', edition: '2004', effectiveFrom: '2006-01-01' })
    const current = doc({ code: 'ГОСТ Р 52290-2024', edition: '2024', effectiveFrom: '2026-01-01' })
    const future = doc({ code: 'ГОСТ Р 52290', edition: '2030', effectiveFrom: '2031-01-01' })
    const statuses = documentStatuses([old, current, future], '2026-09-29')
    expect(statuses.get(old.id)).toEqual({ kind: 'superseded', by: current.id })
    expect(statuses.get(current.id)).toEqual({ kind: 'current' })
    expect(statuses.get(future.id)).toEqual({ kind: 'future', from: '2031-01-01' })
    // До даты введения новой редакции действует прежняя.
    expect(documentStatuses([old, current], '2025-12-31').get(old.id)).toEqual({ kind: 'current' })
    expect(currentDocument([old, current, future], 'гост р 52290', '2031-02-01')?.id).toBe(
      future.id,
    )
  })

  it('uses the edition year when no effective date is given and tracks amendments', () => {
    const base = doc({ code: 'ГОСТ Р 52289', edition: '2019', kind: 'rules' })
    const change = doc({
      code: 'ГОСТ Р 52289',
      edition: 'Изменение № 2',
      kind: 'rules',
      amendsId: base.id,
      effectiveFrom: '2026-07-01',
    })
    const statuses = documentStatuses([base, change], '2026-06-30')
    expect(statuses.get(base.id)).toEqual({ kind: 'current' })
    expect(statuses.get(change.id)).toEqual({ kind: 'amendment', of: base.id, inForce: false })
    expect(documentStatuses([base, change], '2026-07-01').get(change.id)).toMatchObject({
      inForce: true,
    })
  })

  it('reports whether the sign catalog uses the edition currently in force', () => {
    const old = doc({ code: 'ГОСТ Р 52290', edition: '2004', effectiveFrom: '2006-01-01' })
    const current = doc({ code: 'ГОСТ Р 52290', edition: '2024', effectiveFrom: '2026-01-01' })
    const today = '2026-09-29'
    expect(catalogEditionStatus(null, [old, current], today)).toEqual({ kind: 'no-catalog' })
    expect(
      catalogEditionStatus(
        { documentCode: 'ГОСТ Р 52290-2024', edition: '2024' },
        [old, current],
        today,
      ),
    ).toEqual({ kind: 'current', document: current })
    expect(
      catalogEditionStatus(
        { documentCode: 'ГОСТ Р 52290', edition: '2004' },
        [old, current],
        today,
      ),
    ).toEqual({ kind: 'outdated', catalogEdition: '2004', document: current })
    expect(
      catalogEditionStatus({ documentCode: 'ГОСТ Р 52290', edition: '2024' }, [], today),
    ).toEqual({
      kind: 'no-document',
      code: 'ГОСТ Р 52290',
    })
  })

  it('asks to recheck an edition once a year', () => {
    const checked = doc({ code: 'ОДМ 218.6.019', edition: '2016', actualCheckedAt: '2025-09-30' })
    expect(actualityCheckDue(checked, '2026-09-29')).toBe(false)
    expect(actualityCheckDue(checked, '2026-09-30')).toBe(true)
    expect(actualityCheckDue({ ...checked, actualCheckedAt: '' }, '2026-09-29')).toBe(true)
  })
})
