import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { evidenceConfirmation } from './document-evidence-fixture'
import { RegistryStore } from '../store'
import { documentMeta, documentFile } from './normative-document-fixture'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})
function setup(clock: () => string = () => '2030-02-01T00:00:00.000Z') {
  const directory = mkdtempSync(join(tmpdir(), 'tod-evidence-contract-')),
    path = join(directory, 'registry.sqlite'),
    store = new RegistryStore(path, clock),
    raw = new DatabaseSync(path),
    file = documentFile(),
    document = store.addDocument(documentMeta(), file.filename, file.pdf, file.sha256)
  cleanups.push(() => {
    raw.close()
    store.close()
    rmSync(directory, { recursive: true, force: true })
  })
  return { store, raw, document }
}
/** Run against the original facade before moving these four methods. */
describe('document text and parameter confirmation facade contracts', () => {
  it('keeps null/empty scan, exact text and rollback of a failed replacement, including nested BEGIN refusal', () => {
    const { store, raw, document } = setup()
    expect(store.getDocumentText(document.id)).toBeNull()
    expect(store.getDocumentText(999)).toBeNull()
    store.saveDocumentText(document.id, [])
    expect(store.getDocumentText(document.id)).toEqual([''])
    const pages = ['Учебный текст\u0000 со знаками\nи пробелами  ', '', 'Third page']
    store.saveDocumentText(document.id, pages)
    expect(store.getDocumentText(document.id)).toEqual(pages)
    raw.exec(
      "CREATE TRIGGER reject_page AFTER INSERT ON document_pages WHEN NEW.page = 2 BEGIN SELECT RAISE(ABORT, 'second page failed'); END",
    )
    expect(() => store.saveDocumentText(document.id, ['New first', 'New second'])).toThrow(
      'second page failed',
    )
    expect(store.getDocumentText(document.id)).toEqual(pages)
    raw.exec('DROP TRIGGER reject_page')
    // BEGIN refusal must not roll back a transaction owned by the caller.
    const connection = (store as unknown as { db: DatabaseSync }).db
    connection.exec('BEGIN IMMEDIATE')
    expect(() => store.saveDocumentText(document.id, ['Nested replacement'])).toThrow(/transaction/)
    expect(connection.isTransaction).toBe(true)
    connection.exec('ROLLBACK')
    expect(store.getDocumentText(document.id)).toEqual(pages)
  })

  it('keeps append-only repeats, parameter/id order, value JSON, raw fields and clock receiver', () => {
    let calls = 0
    const receivers: unknown[] = []
    const { store, raw, document } = setup(function (this: unknown) {
      calls++
      receivers.push(this)
      return '2030-02-01T00:00:00.000Z'
    })
    calls = 0
    const input = evidenceConfirmation({
        parameterId: 'zzz',
        documentId: document.id,
        documentLabel: 'Учебный документ',
        clause: '1',
        page: 2,
        quote: '  Exact quote\n',
        fragment: 'Exact fragment',
        value: { '20': '10', '40': '25' },
      }),
      first = store.addParameterConfirmation(input),
      second = store.addParameterConfirmation(input),
      decision = store.addParameterConfirmation(
        evidenceConfirmation({ parameterId: 'aaa', confirmedAt: '2020-01-01' }),
      )
    expect(first).toEqual({ ...input, id: first.id })
    expect(first.value).toBe(input.value)
    expect(second.id).toBeGreaterThan(first.id)
    expect(store.listParameterConfirmations()).toEqual([decision, first, second])
    expect(Object.keys(store.listParameterConfirmations()[0]!)).toEqual([
      'id',
      'parameterId',
      'documentId',
      'documentLabel',
      'clause',
      'page',
      'quote',
      'fragment',
      'value',
      'confirmedBy',
      'confirmedAt',
      'note',
    ])
    expect(calls).toBe(3)
    expect(receivers.at(-1)).toBe(store)
    expect(
      raw
        .prepare('SELECT recorded_at, value_json FROM parameter_confirmations WHERE id = ?')
        .get(first.id),
    ).toEqual({ recorded_at: '2030-02-01T00:00:00.000Z', value_json: JSON.stringify(input.value) })
  })

  it('does not append after a clock or SQL failure and preserves earlier confirmations', () => {
    let failClock = false
    const { store, raw } = setup(() => {
        if (failClock) throw new Error('clock failed')
        return '2030-02-01T00:00:00.000Z'
      }),
      first = store.addParameterConfirmation(evidenceConfirmation())
    failClock = true
    expect(() => store.addParameterConfirmation(evidenceConfirmation())).toThrow('clock failed')
    expect(store.listParameterConfirmations()).toEqual([first])
    failClock = false
    raw.exec(
      "CREATE TRIGGER reject_confirmation AFTER INSERT ON parameter_confirmations BEGIN SELECT RAISE(ABORT, 'confirmation failed'); END",
    )
    expect(() => store.addParameterConfirmation(evidenceConfirmation())).toThrow(
      'confirmation failed',
    )
    expect(store.listParameterConfirmations()).toEqual([first])
    raw.exec('DROP TRIGGER reject_confirmation')
    expect(store.addParameterConfirmation(evidenceConfirmation()).id).toBeGreaterThan(first.id)
  })
})
