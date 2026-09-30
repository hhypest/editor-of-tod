import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { DocumentMeta } from '../../src/domain/normative-documents'
import { rulesFrom } from '../../src/domain/normative-parameters'
import { applyDocumentUpload, previewDocumentUpload } from '../document-web-import'
import { confirmParameter, listParameterStates } from '../normative-parameters'
import { DocumentInUse, RegistryStore, RevisionConflict } from '../store'
import { fictionalMethodology as methodology, textPdf } from './pdf-fixture'

const directories: string[] = []
afterEach(() => {
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
  return new RegistryStore(join(directory, 'registry.sqlite'))
}

const state = (states: Awaited<ReturnType<typeof listParameterStates>>, id: string) =>
  states.find((item) => item.id === id)!

describe('normative parameters from library documents', () => {
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
    expect(state(states, 'odm-signs-taper').suggestion).toBe(14)
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
      clause: 'п. 5.4.4',
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
    // Новая редакция: условие 5.4.4 то же (изменено только другое предложение), 5.4.2 другое.
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

    // Действующее изменение к новой редакции упоминает пункт 5.4.4.
    await add(store, textPdf([['Изменение учебное. Пункт 5.4.4 изложить в новой редакции.']]), {
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
