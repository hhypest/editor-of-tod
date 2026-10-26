import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../database/connection'
import { migrateDatabase } from '../database/migration-runner'
import { DocumentTextRepository } from '../documents/document-text-repository'
import { ParameterConfirmationRepository } from '../parameters/confirmation-repository'
import { NormativeDocumentRepository } from '../documents/normative-document-repository'
import { documentText, listParameterStates, confirmParameter } from '../normative-parameters'
import { documentMeta, documentFile } from './normative-document-fixture'
import { evidenceConfirmation } from './document-evidence-fixture'

const connections: DatabaseSync[] = [],
  directories: string[] = []
const now = () => '2030-02-01T00:00:00.000Z'
afterEach(() => {
  for (const db of connections.splice(0).reverse()) db.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})
function setup(path = ':memory:', clock = now) {
  const db = openDatabase(path)
  connections.push(db)
  migrateDatabase(db, { path, now })
  const documents = new NormativeDocumentRepository(db, now),
    text = new DocumentTextRepository(db),
    confirmations = new ParameterConfirmationRepository(db, clock),
    file = documentFile(),
    record = documents.insert(documentMeta(), file.filename, file.pdf, file.sha256),
    storage = {
      listDocuments: () => documents.list(),
      getDocument: (id: number) => documents.get(id),
      getDocumentPdf: (id: number) => documents.getPdf(id),
      getDocumentText: (id: number) => text.get(id),
      saveDocumentText: (id: number, pages: readonly string[]) => text.save(id, pages),
      listParameterConfirmations: () => confirmations.list(),
      addParameterConfirmation: (input: Parameters<ParameterConfirmationRepository['add']>[0]) =>
        confirmations.add(input),
    }
  return { db, documents, text, confirmations, file, record, storage }
}

describe('document evidence storage without RegistryStore', () => {
  it('does not initialize storage; preserves page ordering, null/empty scan and read-only reads', () => {
    const empty = new DatabaseSync(':memory:')
    connections.push(empty)
    new DocumentTextRepository(empty)
    new ParameterConfirmationRepository(empty, now)
    expect(empty.prepare('SELECT name FROM sqlite_master').all()).toEqual([])
    const { db, text, confirmations, record } = setup()
    expect(text.get(record.id)).toBeNull()
    expect(text.get(999)).toBeNull()
    const insert = db.prepare('INSERT INTO document_pages VALUES (?, ?, ?)')
    insert.run(record.id, 3, 'Third')
    insert.run(record.id, 1, 'Учебный\u0000 текст\n  ')
    insert.run(record.id, 2, '')
    expect(text.get(record.id)).toEqual(['Учебный\u0000 текст\n  ', '', 'Third'])
    text.save(record.id, [])
    db.exec('PRAGMA query_only = ON')
    expect(text.get(record.id)).toEqual([''])
    expect(confirmations.list()).toEqual([])
    expect(() => text.save(record.id, ['Rejected'])).toThrow(/readonly/)
    expect(text.get(record.id)).toEqual([''])
    expect(db.isTransaction).toBe(false)
    expect(db.prepare('SELECT COUNT(*) AS count FROM normative').get()).toEqual({ count: 0 })
  })

  it('rolls back the entire cache replacement after a later page fails, and rejects missing document references', () => {
    const { db, text, record, documents, file } = setup(),
      previous = ['Old first', 'Old second', 'Old third'],
      before = documents.get(record.id)
    text.save(record.id, previous)
    db.exec(
      "CREATE TRIGGER reject_second_page AFTER INSERT ON document_pages WHEN NEW.page = 2 BEGIN SELECT RAISE(ABORT, 'second page failed'); END",
    )
    expect(() => text.save(record.id, ['New first', 'New second'])).toThrow('second page failed')
    expect(text.get(record.id)).toEqual(previous)
    expect(db.isTransaction).toBe(false)
    db.exec('DROP TRIGGER reject_second_page')
    text.save(record.id, ['Replaced'])
    expect(text.get(record.id)).toEqual(['Replaced'])
    expect(() => text.save(999, ['Missing'])).toThrow(/FOREIGN KEY/)
    expect(text.get(999)).toBeNull()
    expect(documents.get(record.id)).toEqual(before)
    expect(Buffer.from(documents.getPdf(record.id)!.pdf)).toEqual(file.pdf)
  })

  it('holds the write lock for delete and every inserted page, exposing only old or complete text to another connection', () => {
    const directory = mkdtempSync(join(tmpdir(), 'tod-text-lock-'))
    directories.push(directory)
    const path = join(directory, 'registry.sqlite'),
      { db, text, record } = setup(path),
      other = openDatabase(path)
    connections.push(other)
    other.exec('PRAGMA busy_timeout = 1')
    text.save(record.id, ['Old first', 'Old second'])
    let observed = 0
    db.function('observe_text_lock', () => {
      observed++
      expect(db.isTransaction).toBe(true)
      expect(() =>
        other
          .prepare('UPDATE normative_documents SET note = ? WHERE id = ?')
          .run('blocked', record.id),
      ).toThrow(/locked/)
      expect(
        other
          .prepare('SELECT text FROM document_pages WHERE document_id = ? ORDER BY page')
          .all(record.id),
      ).toEqual([{ text: 'Old first' }, { text: 'Old second' }])
      return 1
    })
    db.exec(
      'CREATE TEMP TRIGGER observe_page AFTER INSERT ON document_pages BEGIN SELECT observe_text_lock(); END',
    )
    text.save(record.id, ['New first', 'New second', 'New third'])
    expect(observed).toBe(3)
    expect(new DocumentTextRepository(other).get(record.id)).toEqual([
      'New first',
      'New second',
      'New third',
    ])
    db.exec('BEGIN IMMEDIATE')
    expect(() => text.save(record.id, ['Nested'])).toThrow(/transaction/)
    expect(db.isTransaction).toBe(true)
    db.exec('ROLLBACK')
    expect(text.get(record.id)).toEqual(['New first', 'New second', 'New third'])
  })

  it('keeps append-only history, null references, numeric/table JSON, exact fields and parameter/id ordering', () => {
    const { db, confirmations, record } = setup(),
      input = evidenceConfirmation({
        parameterId: 'zzz',
        documentId: record.id,
        documentLabel: 'Учебный источник',
        page: 3,
        quote: '  Fictional quote\n',
        fragment: 'Fictional fragment',
        value: { '20': '10', '40': '25' },
      }),
      first = confirmations.add(input),
      second = confirmations.add({ ...input, confirmedAt: '2020-01-01' }),
      decision = confirmations.add(evidenceConfirmation({ parameterId: 'aaa' }))
    expect(confirmations.list()).toEqual([decision, first, second])
    expect(first.value).toBe(input.value)
    expect(confirmations.list()[1]!.value).not.toBe(input.value)
    expect(Object.keys(confirmations.list()[0]!)).toEqual([
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
    const before = confirmations.list()
    expect(() => confirmations.add(evidenceConfirmation({ documentId: 999 }))).toThrow(
      /FOREIGN KEY/,
    )
    expect(confirmations.list()).toEqual(before)
    db.prepare('UPDATE parameter_confirmations SET value_json = ? WHERE id = ?').run(
      'invalid JSON',
      first.id,
    )
    expect(() => confirmations.list()).toThrow(SyntaxError)
  })

  it('preserves clock/statement failures and caller-owned confirmation transactions', () => {
    let failClock = false,
      clockCalls = 0
    const { db, confirmations } = setup(':memory:', () => {
        clockCalls++
        if (failClock) throw new Error('clock failed')
        return now()
      }),
      first = confirmations.add(evidenceConfirmation())
    failClock = true
    expect(() => confirmations.add(evidenceConfirmation())).toThrow('clock failed')
    expect(clockCalls).toBe(2)
    expect(confirmations.list()).toEqual([first])
    failClock = false
    db.exec(
      "CREATE TEMP TRIGGER reject_confirmation AFTER INSERT ON parameter_confirmations BEGIN SELECT RAISE(ABORT, 'insert failed'); END",
    )
    db.exec('BEGIN IMMEDIATE')
    expect(() => confirmations.add(evidenceConfirmation())).toThrow('insert failed')
    expect(db.isTransaction).toBe(true)
    expect(confirmations.list()).toEqual([first])
    db.exec('DROP TRIGGER reject_confirmation')
    confirmations.add(evidenceConfirmation())
    expect(db.isTransaction).toBe(true)
    db.exec('ROLLBACK')
    expect(confirmations.list()).toEqual([first])
  })

  it('reopens committed text/history read-only without touching documents or invoking clocks', () => {
    const directory = mkdtempSync(join(tmpdir(), 'tod-evidence-reopen-'))
    directories.push(directory)
    const path = join(directory, 'registry.sqlite'),
      { text, confirmations, record, documents } = setup(path),
      before = documents.get(record.id)
    text.save(record.id, ['Fictional text'])
    const entry = confirmations.add(evidenceConfirmation({ documentId: record.id })),
      reader = new DatabaseSync(path, { readOnly: true })
    connections.push(reader)
    expect(new DocumentTextRepository(reader).get(record.id)).toEqual(['Fictional text'])
    expect(
      new ParameterConfirmationRepository(reader, () => {
        throw new Error('read called clock')
      }).list(),
    ).toEqual([entry])
    expect(new NormativeDocumentRepository(reader, now).get(record.id)).toEqual(before)
    expect(reader.prepare('PRAGMA user_version').get()).toEqual({ user_version: 13 })
    expect(reader.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  })

  it('uses narrow text/confirmation ports, caches extracted PDF and blank scans, and keeps latest confirmation selection', async () => {
    const { storage, record, text, confirmations, documents } = setup()
    let pdfReads = 0,
      saves = 0
    const cache = {
      getDocumentText: storage.getDocumentText,
      getDocumentPdf(id: number) {
        pdfReads++
        return storage.getDocumentPdf(id)
      },
      saveDocumentText(id: number, pages: readonly string[]) {
        saves++
        storage.saveDocumentText(id, pages)
      },
    }
    expect((await documentText(cache, record.id)).join('\n')).toContain('Fictional document')
    expect(await documentText(cache, record.id)).toEqual(text.get(record.id))
    expect(pdfReads).toBe(1)
    expect(saves).toBe(1)
    text.save(record.id, [])
    expect(await documentText(cache, record.id)).toEqual([''])
    expect(pdfReads).toBe(1)
    await expect(documentText(cache, 999)).rejects.toMatchObject({
      status: 404,
      reason: 'no-document',
      field: 'document',
    })
    const first = await confirmParameter(
      storage,
      'peak-hour-share',
      {
        value: 0.1,
        confirmedBy: 'Учебный специалист',
        note: 'Учебное решение',
        expectedDocumentId: null,
      },
      new Date('2030-02-01T12:00:00'),
    )
    const latest = confirmations.add({
      ...evidenceConfirmation(),
      parameterId: 'peak-hour-share',
      value: 0.2,
      confirmedAt: '2020-01-01',
    })
    expect(
      (await listParameterStates(storage, new Date('2030-02-01T12:00:00'))).find(
        (state) => state.id === 'peak-hour-share',
      )?.confirmation,
    ).toEqual(latest)
    expect(confirmations.list().filter((entry) => entry.parameterId === 'peak-hour-share')).toEqual(
      [first, latest],
    )
    expect(documents.get(record.id)?.sha256).toBe(record.sha256)
  })
})
