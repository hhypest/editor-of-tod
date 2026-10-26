import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../database/connection'
import { migrateDatabase } from '../database/migration-runner'
import { SqliteTransactionRunner } from '../database/transaction-runner'
import { NormativeDocumentRepository } from '../documents/normative-document-repository'
import { DocumentTextRepository } from '../documents/document-text-repository'
import { ParameterConfirmationRepository } from '../parameters/confirmation-repository'
import { SignCatalogDocumentReferences } from '../signs/document-references'
import { DeleteNormativeDocument } from '../documents/delete-normative-document'
import { DocumentInUse } from '../documents/errors'
import { documentMeta, documentFile, seedDocumentBatch } from './normative-document-fixture'
import { evidenceConfirmation } from './document-evidence-fixture'

const connections: DatabaseSync[] = [],
  directories: string[] = []
const now = () => '2030-02-01T00:00:00.000Z'
afterEach(() => {
  for (const db of connections.splice(0).reverse()) db.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})
function setup(path = ':memory:') {
  const db = openDatabase(path)
  connections.push(db)
  migrateDatabase(db, { path, now })
  const documents = new NormativeDocumentRepository(db, now),
    text = new DocumentTextRepository(db),
    confirmations = new ParameterConfirmationRepository(db, now),
    signs = new SignCatalogDocumentReferences(db),
    transactions = new SqliteTransactionRunner(db),
    command = new DeleteNormativeDocument(documents, text, confirmations, signs, transactions),
    file = documentFile(),
    document = documents.insert(documentMeta(), file.filename, file.pdf, file.sha256),
    pages = ['Fictional first page', '', 'Fictional last page']
  text.save(document.id, pages)
  return { db, documents, text, confirmations, signs, transactions, command, file, document, pages }
}

describe('DeleteNormativeDocument without RegistryStore', () => {
  it('does not initialize reference storage, reads historical batches/confirmations and works read-only', () => {
    const empty = new DatabaseSync(':memory:')
    connections.push(empty)
    new SignCatalogDocumentReferences(empty)
    expect(empty.prepare('SELECT name FROM sqlite_master').all()).toEqual([])
    const { db, documents, signs, confirmations, document } = setup(),
      otherFile = documentFile('Other'),
      other = documents.insert(documentMeta(), otherFile.filename, otherFile.pdf, otherFile.sha256)
    expect(signs.countBatches(999)).toBe(0)
    expect(confirmations.countForDocument(999)).toBe(0)
    seedDocumentBatch(db, document.id)
    seedDocumentBatch(db, document.id)
    seedDocumentBatch(db, other.id)
    confirmations.add(evidenceConfirmation({ documentId: document.id }))
    confirmations.add(evidenceConfirmation({ documentId: document.id, confirmedAt: '2020-01-01' }))
    confirmations.add(evidenceConfirmation({ documentId: other.id }))
    db.exec('PRAGMA query_only = ON')
    expect(signs.countBatches(document.id)).toBe(2)
    expect(signs.countBatches(other.id)).toBe(1)
    expect(confirmations.countForDocument(document.id)).toBe(2)
    expect(confirmations.countForDocument(other.id)).toBe(1)
    expect(db.prepare('SELECT COUNT(*) AS count FROM normative').get()).toEqual({ count: 0 })
  })

  it('preserves missing/signs/amendments/confirmations order under the transaction without modifying refused data', () => {
    const { db, documents, text, signs, confirmations, transactions, command, document, pages } =
        setup(),
      amendmentFile = documentFile('Amendment'),
      amendment = documents.insert(
        documentMeta({ amendsId: document.id }),
        amendmentFile.filename,
        amendmentFile.pdf,
        amendmentFile.sha256,
      )
    seedDocumentBatch(db, document.id)
    const confirmation = confirmations.add(evidenceConfirmation({ documentId: document.id })),
      calls: string[] = []
    const guarded = new DeleteNormativeDocument(
      {
        get(id) {
          calls.push('get')
          expect(db.isTransaction).toBe(true)
          return documents.get(id)
        },
        list() {
          calls.push('amendments')
          return documents.list()
        },
        delete(id) {
          calls.push('document delete')
          documents.delete(id)
        },
      },
      {
        delete(id) {
          calls.push('text delete')
          text.delete(id)
        },
      },
      {
        countForDocument(id) {
          calls.push('confirmations')
          return confirmations.countForDocument(id)
        },
      },
      {
        countBatches(id) {
          calls.push('signs')
          return signs.countBatches(id)
        },
      },
      transactions,
    )
    expect(guarded.execute(999)).toBe(false)
    expect(calls.splice(0)).toEqual(['get'])
    expect(() => guarded.execute(document.id)).toThrow(
      'С этим документом сверен импорт каталога знаков',
    )
    expect(calls.splice(0)).toEqual(['get', 'signs'])
    expect(text.get(document.id)).toEqual(pages)
    db.prepare('DELETE FROM sign_catalog_batches WHERE document_id = ?').run(document.id)
    expect(() => guarded.execute(document.id)).toThrow('Сначала удалите изменения')
    expect(calls.splice(0)).toEqual(['get', 'signs', 'amendments'])
    expect(command.execute(amendment.id)).toBe(true)
    expect(() => guarded.execute(document.id)).toThrow(DocumentInUse)
    expect(calls.splice(0)).toEqual(['get', 'signs', 'amendments', 'confirmations'])
    expect(text.get(document.id)).toEqual(pages)
    expect(documents.get(document.id)).toEqual(document)
    expect(confirmations.list()).toEqual([confirmation])
    expect(db.isTransaction).toBe(false)
  })

  it.each(['pages', 'document'] as const)(
    'rolls back both owners after a %s DELETE failure and permits retry',
    (phase) => {
      const { db, documents, text, command, document, pages, file } = setup(),
        before = db.prepare('SELECT * FROM normative_documents').all()
      db.exec(
        phase === 'pages'
          ? "CREATE TRIGGER reject_delete BEFORE DELETE ON document_pages WHEN OLD.page = 2 BEGIN SELECT RAISE(ABORT, 'delete failed'); END"
          : "CREATE TRIGGER reject_delete BEFORE DELETE ON normative_documents BEGIN SELECT RAISE(ABORT, 'delete failed'); END",
      )
      expect(() => command.execute(document.id)).toThrow('delete failed')
      expect(db.isTransaction).toBe(false)
      expect(text.get(document.id)).toEqual(pages)
      expect(db.prepare('SELECT * FROM normative_documents').all()).toEqual(before)
      expect(Buffer.from(documents.getPdf(document.id)!.pdf)).toEqual(file.pdf)
      db.exec('DROP TRIGGER reject_delete')
      expect(command.execute(document.id)).toBe(true)
      expect(text.get(document.id)).toBeNull()
      expect(documents.get(document.id)).toBeNull()
    },
  )

  it('locks before existence checks and blocks a new reference until text/PDF deletion commits', () => {
    const directory = mkdtempSync(join(tmpdir(), 'tod-delete-command-lock-'))
    directories.push(directory)
    const path = join(directory, 'registry.sqlite'),
      { db, documents, text, confirmations, signs, transactions, document, pages } = setup(path),
      other = openDatabase(path)
    connections.push(other)
    other.exec('PRAGMA busy_timeout = 1')
    const otherConfirmations = new ParameterConfirmationRepository(other, now),
      otherText = new DocumentTextRepository(other),
      otherDocuments = new NormativeDocumentRepository(other, now)
    let read = false,
      deletedText = false
    const command = new DeleteNormativeDocument(
      {
        get(id) {
          read = true
          expect(db.isTransaction).toBe(true)
          expect(() => otherConfirmations.add(evidenceConfirmation({ documentId: id }))).toThrow(
            /locked/,
          )
          return documents.get(id)
        },
        list: () => documents.list(),
        delete: (id) => documents.delete(id),
      },
      {
        delete(id) {
          text.delete(id)
          deletedText = true
          expect(db.isTransaction).toBe(true)
          expect(text.get(id)).toBeNull()
          expect(otherText.get(id)).toEqual(pages)
          expect(otherDocuments.get(id)).toEqual(document)
          expect(() => otherConfirmations.add(evidenceConfirmation({ documentId: id }))).toThrow(
            /locked/,
          )
        },
      },
      confirmations,
      signs,
      transactions,
    )
    expect(command.execute(document.id)).toBe(true)
    expect(read && deletedText).toBe(true)
    expect(otherText.get(document.id)).toBeNull()
    expect(otherDocuments.get(document.id)).toBeNull()
    expect(otherConfirmations.list()).toEqual([])
  })

  it('rolls back failed reference reads and rejects nested BEGIN without discarding caller input', () => {
    const { db, documents, text, confirmations, transactions, command, document, pages } = setup(),
      failed = new DeleteNormativeDocument(
        documents,
        text,
        confirmations,
        {
          countBatches() {
            throw new Error('reference query failed')
          },
        },
        transactions,
      )
    expect(() => failed.execute(document.id)).toThrow('reference query failed')
    expect(db.isTransaction).toBe(false)
    expect(text.get(document.id)).toEqual(pages)
    db.exec('BEGIN IMMEDIATE')
    db.prepare('UPDATE normative_documents SET note = ? WHERE id = ?').run(
      'Caller input',
      document.id,
    )
    expect(() => command.execute(document.id)).toThrow(/transaction/)
    expect(db.isTransaction).toBe(true)
    expect(documents.get(document.id)?.note).toBe('Caller input')
    db.exec('ROLLBACK')
    expect(documents.get(document.id)).toEqual(document)
    expect(text.get(document.id)).toEqual(pages)
  })

  it('deletes only the requested document/text and reopens with unrelated history/PDF intact', () => {
    const directory = mkdtempSync(join(tmpdir(), 'tod-delete-command-reopen-'))
    directories.push(directory)
    const path = join(directory, 'registry.sqlite'),
      { db, documents, text, confirmations, command, document } = setup(path),
      otherFile = documentFile('Preserved other document'),
      other = documents.insert(documentMeta(), otherFile.filename, otherFile.pdf, otherFile.sha256)
    text.save(other.id, ['Preserved text'])
    seedDocumentBatch(db, other.id)
    const first = confirmations.add(evidenceConfirmation({ documentId: other.id })),
      second = confirmations.add(evidenceConfirmation()),
      batches = db.prepare('SELECT * FROM sign_catalog_batches').all()
    expect(command.execute(document.id)).toBe(true)
    const reader = new DatabaseSync(path, { readOnly: true })
    connections.push(reader)
    const reopened = new NormativeDocumentRepository(reader, now)
    expect(reopened.get(document.id)).toBeNull()
    expect(reopened.get(other.id)).toEqual(other)
    expect(Buffer.from(reopened.getPdf(other.id)!.pdf)).toEqual(otherFile.pdf)
    expect(new DocumentTextRepository(reader).get(other.id)).toEqual(['Preserved text'])
    expect(new ParameterConfirmationRepository(reader, now).list()).toEqual([first, second])
    expect(reader.prepare('SELECT * FROM sign_catalog_batches').all()).toEqual(batches)
    expect(reader.prepare('PRAGMA user_version').get()).toEqual({ user_version: 13 })
    expect(reader.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  })
})
