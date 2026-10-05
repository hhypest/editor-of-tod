import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { DocumentMeta } from '../../src/domain/normative-documents'
import { parameterDefinitions, rulesFrom } from '../../src/domain/normative-parameters'
import { applyDocumentUpload, previewDocumentUpload } from '../document-web-import'
import { confirmParameter, listParameterStates } from '../normative-parameters'
import { DocumentInUse, RegistryStore, RevisionConflict } from '../store'
import { fictionalMethodology as methodology, textPdf } from './pdf-fixture'
import { createUnlinkedScheme } from '../../src/domain/create-scheme'
import { reviewScheme } from '../../src/domain/review-scheme'
import { markState, setMark, unmarkedChecks } from '../../src/domain/review-marks'

const directories: string[] = []
const stores: RegistryStore[] = []
afterEach(() => {
  // На Windows открытый файл SQLite не даёт удалить временную папку.
  for (const store of stores.splice(0)) store.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

const now = new Date('2031-03-01T12:00:00')

async function add(store: RegistryStore, pdf: Buffer, meta: Partial<DocumentMeta>) {
  const body = {
    file: { name: 'uchebny.pdf', data: pdf.toString('base64') },
    meta: {
      code: 'ОДМ 218.6.019',
      edition: '2016',
      title: 'Учебная методика',
      kind: 'methodology' as const,
      effectiveFrom: '2016-01-01',
      amendsId: null,
      note: '',
      actualCheckedAt: '',
      ...meta,
    },
  }
  const preview = previewDocumentUpload(store, body, now)
  return (
    await applyDocumentUpload(store, { ...body, expectedFingerprint: preview.fingerprint }, now)
  ).document
}

function library() {
  const directory = mkdtempSync(join(tmpdir(), 'tod-parameters-'))
  directories.push(directory)
  const store = new RegistryStore(join(directory, 'registry.sqlite'))
  stores.push(store)
  return store
}

const state = (states: Awaited<ReturnType<typeof listParameterStates>>, id: string) =>
  states.find((item) => item.id === id)!

describe('normative parameters from library documents', () => {
  it('keeps a PDD edition undated until explicitly dated and tracks amendments outside speed clauses', async () => {
    const store = library()
    const document = await add(
      store,
      textPdf([
        [
          'ПДД: вымышленный учебный документ',
          '10.2. Учебное условие с числом 61 км/ч.',
          '10.3. Учебные условия нескольких групп ТС.',
          '10.4. Учебные условия буксировки.',
        ],
      ]),
      { code: 'ПДД', edition: '2030-04-01', effectiveFrom: '' },
    )
    expect(state(await listParameterStates(store, now), 'pdd-speed-settlement').status.kind).toBe(
      'no-document',
    )
    const dated = await add(
      store,
      textPdf([
        [
          'ПДД: другая вымышленная редакция',
          '10.2. Учебное условие с числом 62 км/ч.',
          '10.3. Учебные условия нескольких групп ТС.',
          '10.4. Учебные условия буксировки.',
        ],
      ]),
      { code: 'ПДД', edition: '2030-05-01', effectiveFrom: '2030-09-01' },
    )
    const definition = parameterDefinitions.find(
      (item) => item.id === 'pdd-speed-outside-conditions',
    )!
    if (definition.type !== 'table') throw new Error('Expected table')
    await confirmParameter(
      store,
      definition.id,
      {
        value: definition.fallback,
        confirmedBy: 'Учебный составитель',
        note: 'Учебная сверка всех условий',
        expectedDocumentId: dated.id,
      },
      now,
    )
    const before = rulesFrom(await listParameterStates(store, now))
    expect(before.pddDocument?.id).toBe(dated.id)
    expect(before.confirmed[definition.id]).toBe(true)
    const amendment = await add(
      store,
      textPdf([['Вымышленное изменение', '6.15. Учебный порядок сигналов.']]),
      {
        code: 'Постановление № 1088',
        edition: '2031',
        effectiveFrom: '',
        amendsId: dated.id,
      },
    )
    const undated = rulesFrom(await listParameterStates(store, now))
    expect(undated.confirmed[definition.id]).toBe(true)
    expect(undated.evidence[definition.id]).toBe(before.evidence[definition.id])
    const scheme = createUnlinkedScheme(
      {
        referenceId: 'Учебный ПДД',
        locationText: 'Учебный участок',
        directionLeft: 'А',
        directionRight: 'Б',
        frontMetres: '18',
        taperMetres: '10',
        bufferMetres: '10',
        speedStagesKmh: ['70', '50', '40'],
        location: 'out',
        approachSpeedKmh: '90',
        yellowTemporarySigns: false,
      },
      { rules: before },
    )
    const checked = setMark(
      scheme,
      reviewScheme(scheme, before),
      'pdd-speed',
      true,
      now.toISOString(),
    )
    expect(
      markState(
        checked,
        reviewScheme(checked, undated).find((item) => item.id === 'pdd-speed')!,
      ).status,
    ).toBe('marked')
    store.updateDocument(amendment.id, {
      code: amendment.code,
      edition: amendment.edition,
      title: amendment.title,
      kind: amendment.kind,
      effectiveFrom: '2031-01-01',
      amendsId: amendment.amendsId,
      note: amendment.note,
      actualCheckedAt: amendment.actualCheckedAt,
    })
    const after = rulesFrom(await listParameterStates(store, now))
    expect(after.confirmed[definition.id]).toBe(false)
    expect(after.evidence[definition.id]).not.toBe(before.evidence[definition.id])
    expect(after.pddDocument?.id).not.toBe(document.id)
    expect(
      markState(
        checked,
        reviewScheme(checked, after).find((item) => item.id === 'pdd-speed')!,
      ).status,
    ).toBe('stale')
    store.updateDocument(amendment.id, {
      code: amendment.code,
      edition: amendment.edition,
      title: amendment.title,
      kind: amendment.kind,
      effectiveFrom: '2031-01-02',
      amendsId: amendment.amendsId,
      note: amendment.note,
      actualCheckedAt: amendment.actualCheckedAt,
    })
    const revised = rulesFrom(await listParameterStates(store, now))
    expect(revised.confirmed[definition.id]).toBe(false)
    expect(revised.evidence[definition.id]).not.toBe(after.evidence[definition.id])
  })
  it('requires a new traffic check after a relevant amendment, even after reconfirming the same value', async () => {
    const store = library()
    const document = await add(store, methodology(520), {})
    const who = { confirmedBy: 'Учебный составитель', note: '', expectedDocumentId: document.id }
    await confirmParameter(store, 'odm-signs-hourly', { ...who, value: 260 }, now)
    let scheme = createUnlinkedScheme({
      referenceId: 'TEST-AMENDMENT',
      locationText: 'Учебный участок',
      directionLeft: 'А',
      directionRight: 'Б',
      frontMetres: '18',
      taperMetres: '10',
      bufferMetres: '10',
      speedStagesKmh: ['70', '50', '40'],
      location: 'out',
      approachSpeedKmh: '90',
      yellowTemporarySigns: false,
      workConditions: {
        kind: 'short',
        durationHours: 5,
        daylight: 'day',
        regulatorsPresent: true,
        sectionMetres: null,
      },
    })
    scheme.parameters.regulation = { ...scheme.parameters.regulation, mode: 'two', hourly: '300' }
    const original = rulesFrom(await listParameterStates(store, now))
    scheme = setMark(scheme, reviewScheme(scheme, original), 'b34-traffic', true, now.toISOString())
    const traffic = (rules: typeof original) =>
      reviewScheme(scheme, rules).find((finding) => finding.id === 'b34-traffic')!

    await add(store, textPdf([['Учебное изменение: пункт 6.4.4 требует повторной сверки.']]), {
      code: 'Изменение № 1 к ОДМ 218.6.019',
      edition: '2031',
      effectiveFrom: '2031-01-01',
      amendsId: document.id,
    })
    const amended = rulesFrom(await listParameterStates(store, now))
    expect(amended.signsHourly).toBe(original.signsHourly)
    expect(amended.sources).toEqual(original.sources)
    expect(amended.confirmed['odm-signs-hourly']).toBe(false)
    expect(markState(scheme, traffic(amended)).status).toBe('stale')
    expect(
      unmarkedChecks(scheme, reviewScheme(scheme, amended)).map((finding) => finding.id),
    ).toContain('b34-traffic')

    await confirmParameter(store, 'odm-signs-hourly', { ...who, value: 260 }, now)
    const reconfirmed = rulesFrom(await listParameterStates(store, now))
    expect(reconfirmed.confirmed['odm-signs-hourly']).toBe(true)
    expect(markState(scheme, traffic(reconfirmed)).status).toBe('stale')
    scheme = setMark(
      scheme,
      reviewScheme(scheme, reconfirmed),
      'b34-traffic',
      true,
      now.toISOString(),
    )
    expect(markState(scheme, traffic(reconfirmed)).status).toBe('marked')
    await confirmParameter(
      store,
      'peak-hour-share',
      {
        value: 0.1,
        confirmedBy: who.confirmedBy,
        note: 'Учебный подсчёт',
        expectedDocumentId: null,
      },
      now,
    )
    expect(
      markState(scheme, traffic(rulesFrom(await listParameterStates(store, now)))).status,
    ).toBe('marked')
  })

  it('requires reconfirmation for an old clause in the same library document', async () => {
    const store = library()
    const document = await add(store, methodology(520), {})
    store.addParameterConfirmation({
      parameterId: 'odm-signs-hourly',
      documentId: document.id,
      documentLabel: 'ОДМ 218.6.019-2016',
      clause: 'п. 5.4.4',
      page: 2,
      quote: '',
      fragment: '',
      value: 999,
      confirmedBy: 'Учебный составитель',
      confirmedAt: '2030-01-01',
      note: 'Учебное старое основание',
    })
    const states = await listParameterStates(store, now)
    expect(state(states, 'odm-signs-hourly').status.kind).toBe('changed')
    expect(state(states, 'odm-signs-hourly').confirmation?.value).toBe(999)
    expect(rulesFrom(states).signsHourly).toBe(250)
  })
  it('quotes the GOST tables and invalidates confirmation when a relevant amendment takes effect', async () => {
    const store = library()
    const document = await add(
      store,
      textPdf([
        [
          'Таблица Д.1 - Учебная таблица сочетаний.',
          'Учебные строки проверяются составителем вручную.',
        ],
        ['Таблица И.1 - Учебный отгон.', 'На учебной дороге 14 м - с помощью знаков 2.6 и 2.7.'],
      ]),
      { code: 'ГОСТ Р 58350', kind: 'rules', edition: '2019', effectiveFrom: '2019-07-01' },
    )
    let states = await listParameterStates(store, now)
    expect(state(states, 'gost-work-traffic').quote?.page).toBe(1)
    expect(state(states, 'gost-work-traffic').suggestion).toBeNull()
    expect(state(states, 'odm-signs-taper').suggestion).toBe(14)
    const who = {
      confirmedBy: 'Учебный составитель',
      note: 'Сверены учебные сноски',
      expectedDocumentId: document.id,
    }
    await confirmParameter(store, 'odm-signs-taper', { ...who, value: 14 }, now)
    await add(store, textPdf([['Учебное изменение к таблице И.1.']]), {
      code: 'Изменение № 1 к ГОСТ Р 58350',
      edition: '2031',
      effectiveFrom: '2031-01-01',
      amendsId: document.id,
    })
    states = await listParameterStates(store, now)
    expect(state(states, 'odm-signs-taper').status.kind).toBe('changed')
    expect(rulesFrom(states).confirmed['odm-signs-taper']).toBe(false)
    await confirmParameter(store, 'odm-signs-taper', { ...who, value: 16 }, now)
    expect(state(await listParameterStates(store, now), 'odm-signs-taper').status.kind).toBe(
      'confirmed',
    )
    const traffic = parameterDefinitions.find((item) => item.id === 'gost-work-traffic')!
    await confirmParameter(store, traffic.id, { ...who, value: traffic.fallback }, now)
    await add(store, textPdf([['Учебное изменение пункта 6.1.3.']]), {
      code: 'Изменение № 2 к ГОСТ Р 58350',
      edition: '2033',
      effectiveFrom: '2031-02-01',
      amendsId: document.id,
    })
    expect(state(await listParameterStates(store, now), traffic.id).status.kind).toBe('changed')
    await add(store, textPdf([['Учебная поправка к пункту 4.1.']]), {
      code: 'Поправка к ГОСТ Р 58350',
      edition: '2032',
      effectiveFrom: '2031-02-01',
      amendsId: document.id,
    })
    expect(state(await listParameterStates(store, now), 'odm-signs-taper').status.kind).toBe(
      'confirmed',
    )
  })
  it('quotes clauses of the current edition and suggests values from their text', async () => {
    const store = library()
    const document = await add(store, methodology(520), {})
    const states = await listParameterStates(store, now)
    expect(state(states, 'odm-signs-hourly')).toMatchObject({
      status: { kind: 'unconfirmed' },
      document: { id: document.id, label: 'ОДМ 218.6.019-2016' },
      quote: { page: 2 },
      suggestion: 260,
    })
    expect(state(states, 'odm-signs-hourly').quote!.text).toContain('менее 45 м')
    expect(state(states, 'odm-signs-length').suggestion).toBe(45)
    expect(state(states, 'odm-alternate-hourly').suggestion).toBe(520)
    expect(state(states, 'odm-signs-taper').status).toEqual({ kind: 'no-document' })
    expect(state(states, 'odm-regulator-distance').suggestion).toEqual({ '30': '12', '50': '34' })
    expect(state(states, 'gost-speed-step').status).toEqual({ kind: 'no-document' })
    expect(state(states, 'peak-hour-share').status).toEqual({ kind: 'unconfirmed' })
    expect(store.getDocumentText(document.id)).toHaveLength(3)
    expect(rulesFrom(states).signsHourly).toBe(250)
  })

  it('records a confirmation with the quote and uses it in the rules', async () => {
    const store = library()
    const document = await add(store, methodology(520), {})
    await expect(
      confirmParameter(
        store,
        'odm-signs-hourly',
        { value: 260, confirmedBy: 'Учебный составитель', note: '', expectedDocumentId: 999 },
        now,
      ),
    ).rejects.toBeInstanceOf(RevisionConflict)
    const confirmation = await confirmParameter(
      store,
      'odm-signs-hourly',
      { value: 260, confirmedBy: 'Учебный составитель', note: '', expectedDocumentId: document.id },
      now,
    )
    expect(confirmation).toMatchObject({
      documentLabel: 'ОДМ 218.6.019-2016',
      clause: 'п. 6.4.4',
      page: 2,
      value: 260,
      confirmedAt: '2031-03-01',
    })
    const rules = rulesFrom(await listParameterStates(store, now))
    expect(rules.signsHourly).toBe(260)
    expect(rules.confirmed['odm-signs-hourly']).toBe(true)
    await expect(
      confirmParameter(
        store,
        'odm-signs-hourly',
        { value: 0, confirmedBy: 'Учебный составитель', note: '', expectedDocumentId: document.id },
        now,
      ),
    ).rejects.toThrow('Допустимо')
    expect(() => store.deleteDocument(document.id)).toThrow(DocumentInUse)
  })

  it('requires grounds for a compiler decision', async () => {
    const store = library()
    const input = { value: 0.1, confirmedBy: 'Учебный составитель', expectedDocumentId: null }
    await expect(
      confirmParameter(store, 'peak-hour-share', { ...input, note: '' }, now),
    ).rejects.toThrow('основание')
    await confirmParameter(store, 'peak-hour-share', { ...input, note: 'Учебный подсчёт' }, now)
    const states = await listParameterStates(store, now)
    expect(state(states, 'peak-hour-share').status).toEqual({ kind: 'confirmed' })
    expect(rulesFrom(states).peakHourShare).toBe(0.1)
  })

  it('asks to reconfirm after a new edition and tells whether the clause changed', async () => {
    const store = library()
    const old = await add(store, methodology(520), {})
    const who = { confirmedBy: 'Учебный составитель', note: '', expectedDocumentId: old.id }
    await confirmParameter(store, 'odm-signs-hourly', { ...who, value: 260 }, now)
    await confirmParameter(store, 'odm-alternate-hourly', { ...who, value: 520 }, now)
    // Новая редакция: условие 6.4.4 то же (изменено только другое предложение), 6.4.2 другое.
    const next = await add(store, methodology(610, ' Учебное дополнение.'), {
      edition: '2030',
      effectiveFrom: '2030-01-01',
    })
    const states = await listParameterStates(store, now)
    expect(state(states, 'odm-signs-hourly')).toMatchObject({
      status: { kind: 'same-text', previous: 'ОДМ 218.6.019-2016' },
      document: { id: next.id },
    })
    expect(state(states, 'odm-alternate-hourly')).toMatchObject({
      status: { kind: 'changed', previous: 'ОДМ 218.6.019-2016' },
      suggestion: 610,
    })
    const rules = rulesFrom(states)
    expect(rules.alternateHourly).toBe(520)
    expect(rules.confirmed['odm-alternate-hourly']).toBe(false)

    // Действующее изменение к новой редакции упоминает пункт 6.4.4.
    await add(store, textPdf([['Изменение учебное. Пункт 6.4.4 изложить в новой редакции.']]), {
      code: 'Изменение № 1 к ОДМ 218.6.019',
      edition: '2031',
      effectiveFrom: '2031-01-01',
      amendsId: next.id,
    })
    const amended = await listParameterStates(store, now)
    expect(state(amended, 'odm-signs-hourly').amendments).toEqual([
      'Изменение № 1 к ОДМ 218.6.019 (2031)',
    ])
    expect(state(amended, 'odm-signs-taper').amendments).toEqual([])
  })
})
