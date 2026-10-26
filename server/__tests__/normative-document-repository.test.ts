import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../database/connection'
import { migrateDatabase } from '../database/migration-runner'
import { NormativeDocumentRepository } from '../documents/normative-document-repository'
import { NormativeDocumentService } from '../documents/normative-document-service'
import { DocumentInUse } from '../documents/errors'

import { applyDocumentUpload, previewDocumentUpload } from '../document-web-import'
import { RevisionConflict } from '../storage-errors'
import { documentMeta, documentFile, seedDocumentBatch } from './normative-document-fixture'

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
  const repository = new NormativeDocumentRepository(db, clock),
    countSignBatches = (id: number) =>
      (
        db
          .prepare('SELECT COUNT(*) AS count FROM sign_catalog_batches WHERE document_id = ?')
          .get(id) as { count: number }
      ).count,
    service = new NormativeDocumentService(repository, countSignBatches)
  const add = (text: string, meta = documentMeta()) => {
    const file = documentFile(text)
    return service.add(meta, file.filename, file.pdf, file.sha256)
  }
  return { db, repository, service, countSignBatches, add }
}

describe('normative documents without RegistryStore', () => {
  it('does not initialize storage and keeps SQL ordering, metadata whitelist and exact PDF bytes on read-only storage', () => {
    const empty = new DatabaseSync(':memory:')
    connections.push(empty)
    new NormativeDocumentRepository(empty, now)
    expect(empty.prepare('SELECT name FROM sqlite_master').all()).toEqual([])
    const { db, repository, add } = setup(),
      later = add('Later', documentMeta({ code: 'BBB', effectiveFrom: '2030-01-01' })),
      early = add('Early', documentMeta({ code: 'AAA', effectiveFrom: '2020-01-01' })),
      firstTie = add('First tie', documentMeta({ code: 'AAA', effectiveFrom: '2030-01-01' })),
      secondTie = add('Second tie', documentMeta({ code: 'AAA', effectiveFrom: '2030-01-01' }))
    db.exec('PRAGMA query_only = ON')
    expect(repository.list().map((record) => record.id)).toEqual([
      early.id,
      firstTie.id,
      secondTie.id,
      later.id,
    ])
    const file = documentFile('Early')
    expect(repository.get(early.id)).toEqual(repository.findBySha(file.sha256))
    expect(repository.getPdf(early.id)).toEqual({
      filename: file.filename,
      pdf: new Uint8Array(file.pdf),
    })
    expect(repository.get(999)).toBeNull()
    expect(repository.findBySha('missing')).toBeNull()
    expect(Object.keys(repository.list()[0]!)).toEqual([
      'id',
      'code',
      'edition',
      'title',
      'kind',
      'effectiveFrom',
      'amendsId',
      'note',
      'actualCheckedAt',
      'filename',
      'sha256',
      'sizeBytes',
      'addedAt',
    ])
    expect(() => repository.update(early.id, documentMeta())).toThrow(/readonly/)
    expect(db.prepare('SELECT COUNT(*) AS count FROM normative').get()).toEqual({ count: 0 })
  })

  it('reopens without migration and reads committed changes from another connection', () => {
    const directory = mkdtempSync(join(tmpdir(), 'tod-documents-reopen-'))
    directories.push(directory)
    const path = join(directory, 'registry.sqlite'),
      { repository, add } = setup(path),
      record = add('Before reopen'),
      other = openDatabase(path)
    connections.push(other)
    other
      .prepare('UPDATE normative_documents SET title = ? WHERE id = ?')
      .run('Committed title', record.id)
    expect(repository.get(record.id)?.title).toBe('Committed title')
    const readonly = new DatabaseSync(path, { readOnly: true })
    connections.push(readonly)
    const reader = new NormativeDocumentRepository(readonly, () => {
      throw new Error('read called clock')
    })
    expect(reader.get(record.id)).toEqual(repository.get(record.id))
    expect(reader.getPdf(record.id)).toEqual(repository.getPdf(record.id))
    expect(readonly.prepare('PRAGMA user_version').get()).toEqual({ user_version: 13 })
  })

  it('calls the sign-reference port only for a kind change, preserves error identity and stops on query failure', () => {
    const { repository, add } = setup(),
      record = add('Reference check')
    let queries = 0
    const service = new NormativeDocumentService(repository, () => {
      queries++
      throw new Error('reference query failed')
    })
    expect(service.update(record.id, documentMeta({ note: 'Metadata only' }))?.note).toBe(
      'Metadata only',
    )
    expect(service.update(999, documentMeta({ kind: 'rules' }))).toBeNull()
    expect(queries).toBe(0)
    expect(() => service.update(record.id, documentMeta({ kind: 'rules' }))).toThrow(
      'reference query failed',
    )
    expect(queries).toBe(1)
    expect(repository.get(record.id)?.kind).toBe('signs')
    const referenced = new NormativeDocumentService(repository, () => 1)
    expect(() =>
      referenced.update(record.id, documentMeta({ kind: 'rules', amendsId: record.id })),
    ).toThrow('вид документа изменить нельзя')

    expect(new DocumentInUse('test').name).toBe('DocumentInUse')
  })

  it('keeps validation/duplicate/clock order and does not start a transaction around an insert', () => {
    let calls = 0,
      failClock = false
    const { db, service, add, repository } = setup(':memory:', () => {
        calls++
        expect(db.isTransaction).toBe(false)
        if (failClock) throw new Error('clock failed')
        return now()
      }),
      file = documentFile('Clock input')
    expect(() =>
      service.add(documentMeta({ code: '' }), file.filename, file.pdf, file.sha256),
    ).toThrow()
    expect(calls).toBe(0)
    const record = add('Clock input')
    expect(calls).toBe(1)
    expect(() =>
      service.add(documentMeta({ amendsId: 999 }), file.filename, file.pdf, file.sha256),
    ).toThrow('Этот PDF уже есть в библиотеке.')
    expect(() => service.update(999, documentMeta({ code: '' }))).toThrow()
    failClock = true
    expect(() => add('Clock failure')).toThrow('clock failed')
    expect(repository.list()).toEqual([record])
    expect(calls).toBe(2)
    expect(db.isTransaction).toBe(false)
  })

  it('participates in a caller transaction and leaves rollback and lock ownership with the caller', () => {
    const directory = mkdtempSync(join(tmpdir(), 'tod-document-transaction-'))
    directories.push(directory)
    const path = join(directory, 'registry.sqlite'),
      { db, service, repository, add } = setup(path),
      other = openDatabase(path)
    connections.push(other)
    other.exec('PRAGMA busy_timeout = 1')
    db.exec('BEGIN IMMEDIATE')
    const record = add('Caller transaction')
    expect(db.isTransaction).toBe(true)
    expect(other.prepare('SELECT COUNT(*) AS count FROM normative_documents').get()).toEqual({
      count: 0,
    })
    expect(() => other.prepare('UPDATE normative_documents SET note = ?').run('blocked')).toThrow(
      /locked/,
    )
    db.exec(
      "CREATE TEMP TRIGGER reject_document_update AFTER UPDATE ON normative_documents BEGIN SELECT RAISE(ABORT, 'rejected update'); END",
    )
    expect(() => service.update(record.id, documentMeta({ title: 'Rejected' }))).toThrow(
      'rejected update',
    )
    expect(db.isTransaction).toBe(true)
    expect(repository.get(record.id)?.title).toBe(record.title)
    db.exec('ROLLBACK')
    expect(repository.get(record.id)).toBeNull()
    expect(db.isTransaction).toBe(false)
  })

  it('keeps attachment restrictions while allowing explicit detach/reattach without rewriting file fields', () => {
    const { repository, service, add } = setup(),
      base = add('Base'),
      other = add('Other base'),
      amendment = add('Amendment', documentMeta({ kind: 'rules', amendsId: base.id })),
      file = repository.getPdf(amendment.id)
    expect(() => service.update(base.id, documentMeta({ amendsId: other.id }))).toThrow(
      'он не может сам быть изменением',
    )
    expect(() => service.update(other.id, documentMeta({ amendsId: amendment.id }))).toThrow(
      'а не к другому изменению',
    )
    expect(() => service.update(amendment.id, documentMeta({ amendsId: amendment.id }))).toThrow(
      'Документ не может изменять сам себя.',
    )
    expect(() => service.update(amendment.id, documentMeta({ amendsId: 999 }))).toThrow(
      'Изменяемый документ не найден',
    )
    const detached = service.update(amendment.id, documentMeta({ amendsId: null }))!
    expect(detached).toEqual({ ...amendment, ...documentMeta() })
    expect(service.update(amendment.id, documentMeta({ amendsId: other.id }))?.amendsId).toBe(
      other.id,
    )
    expect(repository.getPdf(amendment.id)).toEqual(file)
  })

  it('does not change text, confirmations or historical batches during a metadata edit', () => {
    const { db, service, add } = setup(),
      record = add('Referenced document')
    seedDocumentBatch(db, record.id)
    db.prepare('INSERT INTO document_pages VALUES (?, 1, ?)').run(
      record.id,
      'Fictional extracted text',
    )
    db.prepare(
      `INSERT INTO parameter_confirmations
      (parameter_id, document_id, document_label, clause, page, quote, fragment, value_json, confirmed_by, confirmed_at, note, recorded_at)
      VALUES ('fictional', ?, 'Fictional source', '1', 1, 'Fictional quote', '', '123', 'Fictional specialist', '2030-01-30', '', '2030-02-01T00:00:00.000Z')`,
    ).run(record.id)
    const tables = ['document_pages', 'parameter_confirmations', 'sign_catalog_batches'],
      snapshot = () => tables.map((table) => db.prepare(`SELECT * FROM ${table}`).all()),
      before = snapshot()
    expect(
      service.update(
        record.id,
        documentMeta({
          code: 'Учебный стандарт 90001',
          edition: '2031',
          title: 'Metadata changed',
          note: 'Edited',
        }),
      ),
    ).toMatchObject({
      edition: '2031',
      sha256: record.sha256,
      addedAt: record.addedAt,
      sizeBytes: record.sizeBytes,
    })
    expect(snapshot()).toEqual(before)
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  })

  it('keeps the narrow upload port, no-write preview, backup failures and stale post-backup plans', async () => {
    const { repository, service } = setup(),
      file = documentFile('Upload candidate'),
      meta = documentMeta(),
      body = {
        file: { name: 'local/folder/fictional.pdf', data: file.pdf.toString('base64') },
        meta,
      },
      date = new Date('2030-02-01T12:00:00'),
      preview = previewDocumentUpload({ listDocuments: () => repository.list() }, body, date)
    expect(preview).toMatchObject({ filename: 'fictional.pdf', duplicate: null })
    expect(repository.list()).toEqual([])
    let backups = 0,
      writes = 0,
      failBackup = true,
      mutate = false
    const commands = {
      listDocuments: () => repository.list(),
      addDocument(...args: Parameters<NormativeDocumentService['add']>) {
        writes++
        return service.add(...args)
      },
      async createBackup() {
        backups++
        await Promise.resolve()
        if (failBackup) throw new Error('backup failed')
        if (mutate) {
          const other = documentFile('Concurrent document')
          service.add(meta, other.filename, other.pdf, other.sha256)
        }
        return 'fictional-backup.sqlite'
      },
    }
    await expect(
      applyDocumentUpload(commands, { ...body, expectedFingerprint: '0'.repeat(64) }, date),
    ).rejects.toThrow(RevisionConflict)
    expect(backups).toBe(0)
    await expect(
      applyDocumentUpload(commands, { ...body, expectedFingerprint: preview.fingerprint }, date),
    ).rejects.toThrow('backup failed')
    expect(writes).toBe(0)
    failBackup = false
    mutate = true
    await expect(
      applyDocumentUpload(commands, { ...body, expectedFingerprint: preview.fingerprint }, date),
    ).rejects.toThrow(RevisionConflict)
    expect(writes).toBe(0)
    expect(repository.findBySha(file.sha256)).toBeNull()
    mutate = false
    const fresh = previewDocumentUpload(commands, body, date),
      added = await applyDocumentUpload(
        commands,
        { ...body, expectedFingerprint: fresh.fingerprint },
        date,
      )
    expect(added).toMatchObject({
      document: { filename: 'fictional.pdf', sha256: file.sha256 },
      backup: 'fictional-backup.sqlite',
    })
    expect(writes).toBe(1)
  })
})
