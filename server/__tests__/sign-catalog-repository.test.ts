import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { zipSync } from 'fflate'
import { PNG } from 'pngjs'
import { afterEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../database/connection'
import { migrateDatabase } from '../database/migration-runner'
import { SignCatalogRepository } from '../signs/catalog-repository'
import type { SignImportCommands } from '../signs/import-commands'
import { SignCatalogDocumentReferences } from '../signs/document-references'
import { NormativeDocumentRepository } from '../documents/normative-document-repository'
import { applySignUpload, previewSignUpload } from '../sign-web-import'
import { applyPdfSigns, previewPdfSigns, pdfSignImage } from '../sign-pdf-import'
import { RevisionConflict } from '../storage-errors'
import { catalogEntry, catalogSource } from './sign-catalog-fixture'
import { documentMeta, documentFile } from './normative-document-fixture'
import { fictionalSignStandard } from './pdf-fixture'

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
  return {
    db,
    repository: new SignCatalogRepository(db, clock),
    documents: new NormativeDocumentRepository(db, now),
  }
}
function snapshot(db: DatabaseSync) {
  return ['sign_catalog_batches', 'signs', 'sign_active', 'sign_revisions'].map((table) =>
    db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
  )
}

describe('sign catalog without RegistryStore', () => {
  it('does not initialize storage and keeps active ordering, escaped search/limit, bytes and read-only reads', () => {
    const empty = new DatabaseSync(':memory:')
    connections.push(empty)
    new SignCatalogRepository(empty, now)
    expect(empty.prepare('SELECT name FROM sqlite_master').all()).toEqual([])
    const { db, repository } = setup(),
      first = catalogEntry('9.98'),
      second = catalogEntry('9.99_ж', 120)
    repository.import([second, first], catalogSource())
    db.exec('PRAGMA query_only = ON')
    expect(repository.list().map((entry) => entry.code)).toEqual(['9.98', '9.99_ж'])
    expect(repository.list('', 1).map((entry) => entry.code)).toEqual(['9.98'])
    expect(repository.list('_').map((entry) => entry.code)).toEqual(['9.99_ж'])
    expect(repository.list('%')).toEqual([])
    expect(repository.list('\\')).toEqual([])
    expect(Buffer.from(repository.getPng(first.code, true)!)).toEqual(first.numberedPng)
    expect(Buffer.from(repository.getPng(first.code, false)!)).toEqual(first.plainPng)
    expect(repository.getPng('missing', false)).toBeNull()
    expect(repository.getMetadata(first.code, 999)).toBeNull()
    expect(repository.latest()).toMatchObject({ signCount: 2, documentId: null, edition: '2030' })
    expect(db.prepare('SELECT COUNT(*) AS count FROM normative').get()).toEqual({ count: 0 })
  })

  it('keeps pinned plain-PNG dimensions independent of current metadata and rejects malformed historical headers', () => {
    const { db, repository } = setup(),
      first = catalogEntry('9.99', 100),
      next = catalogEntry('9.99', 120, 24, 12)
    repository.import([{ ...first, width: 99, height: 98 }])
    expect(repository.list()[0]).toMatchObject({ width: 99, height: 98 })
    expect(repository.getMetadata(first.code, 1)).toEqual({
      code: first.code,
      revision: 1,
      width: 8,
      height: 6,
    })
    repository.import([next])
    expect(repository.getMetadata(first.code, 1)).toMatchObject({ width: 8, height: 6 })
    expect(repository.getMetadata(first.code, 2)).toMatchObject({ width: 24, height: 12 })
    repository.import([])
    expect(repository.getPng(first.code, false)).toBeNull()
    expect(repository.getPng(first.code, false, 2)).not.toBeNull()
    expect(repository.getMetadata(first.code, 3)).toBeNull()
    const corrupt = db.prepare(
        'UPDATE sign_revisions SET plain_png = ? WHERE code = ? AND revision = 1',
      ),
      zeroWidth = Buffer.from(first.plainPng)
    zeroWidth.writeUInt32BE(0, 16)
    for (const bytes of [Buffer.alloc(24), first.plainPng.subarray(0, 23), zeroWidth]) {
      corrupt.run(bytes, first.code)
      expect(repository.getMetadata(first.code, 1)).toBeNull()
    }
  })

  it('keeps default-source/no-op/archive semantics, relabel-only batches, duplicate refusal and empty-batch retirement', () => {
    const { db, repository } = setup(),
      entry = catalogEntry()
    expect(() => repository.import([entry, entry])).toThrow(`Повторный код знака: ${entry.code}.`)
    expect(repository.latest()).toBeNull()
    repository.import([entry])
    expect(repository.latest()).toMatchObject({
      documentCode: 'Источник не указан',
      edition: 'не указана',
      pdfSha256: null,
      documentId: null,
    })
    const before = snapshot(db)
    expect(repository.import([{ ...entry, zipSha256: 'f'.repeat(64) }])).toMatchObject({
      unchanged: 1,
    })
    expect(snapshot(db)).toEqual(before)
    const source = catalogSource(),
      revision = db.prepare('SELECT * FROM sign_revisions').all()
    expect(repository.import([entry], source)).toMatchObject({
      updated: 1,
      relabelled: 1,
      changedCodes: [],
    })
    expect(db.prepare('SELECT * FROM sign_revisions').all()).toEqual(revision)
    expect(repository.import([], source)).toMatchObject({ retired: 1, retiredCodes: [entry.code] })
    expect(repository.latest()).toMatchObject({ signCount: 0, zipSha256: '' })
    const retired = snapshot(db)
    repository.import([], source)
    expect(snapshot(db)).toEqual(retired)
    expect(repository.import([entry], source)).toMatchObject({ added: 1 })
    expect(repository.list()[0]?.revision).toBe(3)
  })

  it.each(['write', 'retire', 'clock'] as const)(
    'rolls back the whole catalog after a late %s failure',
    (failure) => {
      let failed = false,
        calls = 0
      const { db, repository } = setup(':memory:', () => {
          if (failed && ++calls === 4) throw new Error('late clock failure')
          return now()
        }),
        first = catalogEntry('9.98', 100),
        retired = catalogEntry('9.99', 120),
        source = catalogSource()
      repository.import([first, retired], source)
      const next = [catalogEntry(first.code, 140), catalogEntry('9.97', 160)],
        before = snapshot(db),
        plan = repository.plan(next, source)
      if (failure === 'write')
        db.exec(
          "CREATE TRIGGER reject_catalog AFTER INSERT ON sign_revisions WHEN NEW.code = '9.97' BEGIN SELECT RAISE(ABORT, 'late write failure'); END",
        )
      if (failure === 'retire')
        db.exec(
          "CREATE TRIGGER reject_catalog AFTER INSERT ON sign_revisions WHEN NEW.active = 0 BEGIN SELECT RAISE(ABORT, 'late retirement failure'); END",
        )
      failed = failure === 'clock'
      expect(() => repository.import(next, source)).toThrow(/late .* failure/)
      expect(snapshot(db)).toEqual(before)
      expect(repository.plan(next, source)).toEqual(plan)
      expect(db.isTransaction).toBe(false)
      failed = false
      if (failure !== 'clock') db.exec('DROP TRIGGER reject_catalog')
      expect(repository.import(next, source)).toEqual(plan)
    },
  )

  it('keeps one write lock and exposes the previous complete catalog until commit', () => {
    const directory = mkdtempSync(join(tmpdir(), 'tod-sign-lock-'))
    directories.push(directory)
    const path = join(directory, 'registry.sqlite')
    let recording = false,
      observations = 0
    const { db, repository } = setup(path, () => {
      if (recording) {
        observations++
        expect(db.isTransaction).toBe(true)
        expect(() => other.prepare('UPDATE signs SET revision = revision + 1').run()).toThrow(
          /locked/,
        )
        expect(new SignCatalogRepository(other, now).list().map((entry) => entry.code)).toEqual([
          '9.98',
          '9.99',
        ])
      }
      return now()
    })
    const other = openDatabase(path)
    connections.push(other)
    other.exec('PRAGMA busy_timeout = 1')
    repository.import([catalogEntry('9.98', 100), catalogEntry('9.99', 120)])
    recording = true
    repository.import([catalogEntry('9.98', 140), catalogEntry('9.97', 160)])
    expect(observations).toBe(4)
    expect(new SignCatalogRepository(other, now).list().map((entry) => entry.code)).toEqual([
      '9.97',
      '9.98',
    ])
  })

  it('preserves historical document references and PNG bytes after read-only reopen; FK refusal rolls back', () => {
    const directory = mkdtempSync(join(tmpdir(), 'tod-sign-reopen-'))
    directories.push(directory)
    const path = join(directory, 'registry.sqlite'),
      { db, repository, documents } = setup(path),
      file = documentFile(),
      document = documents.insert(documentMeta(), file.filename, file.pdf, file.sha256),
      entry = catalogEntry(),
      source = catalogSource({ documentId: document.id })
    repository.import([entry], source)
    const before = snapshot(db)
    expect(() =>
      repository.import(
        [catalogEntry(entry.code, 160)],
        catalogSource({ edition: '2031', documentId: 999 }),
      ),
    ).toThrow(/FOREIGN KEY/)
    expect(snapshot(db)).toEqual(before)
    repository.import([entry], catalogSource({ edition: '2031' }))
    const reader = new DatabaseSync(path, { readOnly: true })
    connections.push(reader)
    const reopened = new SignCatalogRepository(reader, () => {
      throw new Error('read called clock')
    })
    expect(reopened.latest()).toMatchObject({ edition: '2031', documentId: null })
    expect(new SignCatalogDocumentReferences(reader).countBatches(document.id)).toBe(1)
    expect(Buffer.from(reopened.getPng(entry.code, false, 1)!)).toEqual(entry.plainPng)
    expect(reopened.getMetadata(entry.code, 1)).toMatchObject({ width: 8, height: 6 })
    expect(reader.prepare('PRAGMA user_version').get()).toEqual({ user_version: 13 })
    expect(reader.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  })

  it('supports narrow ZIP commands and preserves backup failure, stale metadata and no-op without backup', async () => {
    const { repository, documents } = setup(),
      entry = catalogEntry(),
      file = documentFile(),
      meta = documentMeta(),
      document = documents.insert(meta, file.filename, file.pdf, file.sha256),
      archive = Buffer.from(
        zipSync({
          [`PNG с номером/${entry.code}.png`]: entry.numberedPng,
          [`PNG без номера/${entry.code}.png`]: entry.plainPng,
        }),
      ),
      body = {
        archive: { name: 'fictional.zip', data: archive.toString('base64') },
        documentCode: 'ignored',
        edition: 'ignored',
        documentId: document.id,
        pdf: null,
      }
    let backups = 0,
      writes = 0,
      failBackup = true,
      mutate = false
    const commands: SignImportCommands = {
      getDocument: (id) => documents.get(id),
      getDocumentPdf: (id) => documents.getPdf(id),
      latestSignCatalog: () => repository.latest(),
      planSigns: (entries, source) => repository.plan(entries, source),
      importSigns(entries, source) {
        writes++
        return repository.import(entries, source)
      },
      async createBackup() {
        backups++
        if (failBackup) throw new Error('backup failed')
        if (mutate) documents.update(document.id, { ...meta, edition: '2031' })
        return 'fictional-backup.sqlite'
      },
    }
    const preview = previewSignUpload(commands, body)
    expect(repository.list()).toEqual([])
    await expect(
      applySignUpload(commands, { ...body, expectedFingerprint: '0'.repeat(64) }),
    ).rejects.toThrow(RevisionConflict)
    expect(backups).toBe(0)
    await expect(
      applySignUpload(commands, { ...body, expectedFingerprint: preview.fingerprint }),
    ).rejects.toThrow('backup failed')
    expect(writes).toBe(0)
    failBackup = false
    mutate = true
    await expect(
      applySignUpload(commands, { ...body, expectedFingerprint: preview.fingerprint }),
    ).rejects.toThrow(RevisionConflict)
    expect(writes).toBe(0)
    mutate = false
    const fresh = previewSignUpload(commands, body)
    expect(
      await applySignUpload(commands, { ...body, expectedFingerprint: fresh.fingerprint }),
    ).toMatchObject({ added: 1, backup: 'fictional-backup.sqlite' })
    const noOp = previewSignUpload(commands, body)
    expect(
      await applySignUpload(commands, { ...body, expectedFingerprint: noOp.fingerprint }),
    ).toMatchObject({ unchanged: 1, backup: null })
    expect(backups).toBe(3)
    expect(writes).toBe(1)
  })

  it('extracts/previews/applies a synthetic PDF through narrow commands and reads its image through document-only operations', async () => {
    const { repository, documents } = setup(),
      pdf = fictionalSignStandard(),
      document = documents.insert(documentMeta(), 'fictional-standard.pdf', pdf, 'a'.repeat(64))
    let backups = 0
    const commands: SignImportCommands = {
        getDocument: (id) => documents.get(id),
        getDocumentPdf: (id) => documents.getPdf(id),
        latestSignCatalog: () => repository.latest(),
        planSigns: (entries, source) => repository.plan(entries, source),
        importSigns: (entries, source) => repository.import(entries, source),
        async createBackup() {
          backups++
          return 'fictional-backup.sqlite'
        },
      },
      body = { overrides: { '2-5': '1.33', '3-1': null } },
      preview = await previewPdfSigns(commands, document.id, body)
    expect(preview.added).toBeGreaterThan(0)
    expect(repository.latest()).toBeNull()
    const applied = await applyPdfSigns(commands, document.id, {
      ...body,
      expectedFingerprint: preview.fingerprint,
    })
    expect(applied).toMatchObject({
      added: preview.signCount,
      backup: 'fictional-backup.sqlite',
      catalog: { documentId: document.id },
    })
    expect(
      PNG.sync.read(
        await pdfSignImage(
          { getDocument: commands.getDocument, getDocumentPdf: commands.getDocumentPdf },
          document.id,
          '2-1',
          false,
        ),
      ).width,
    ).toBeGreaterThan(0)
    expect(backups).toBe(1)
    const next = await previewPdfSigns(commands, document.id, body)
    expect(
      await applyPdfSigns(commands, document.id, {
        ...body,
        expectedFingerprint: next.fingerprint,
      }),
    ).toMatchObject({ backup: null })
    expect(backups).toBe(1)
  })
})
