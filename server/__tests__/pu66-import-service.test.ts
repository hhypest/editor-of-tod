import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { createSampleWorkbook, sampleCards } from '../../scripts/generate-pu66-samples'
import type { Pu66ImportRestore, Pu66LifecycleWrite } from '../../src/domain/pu66-lifecycle'
import { openDatabase } from '../database/connection'
import { migrateDatabase } from '../database/migration-runner'
import { SqliteTransactionRunner } from '../database/transaction-runner'
import { Pu66KeyResolver } from '../pu66/key-resolver'
import { Pu66Repository } from '../pu66/repository'
import { Pu66LifecycleRepository } from '../pu66/lifecycle-repository'
import { Pu66LifecycleService } from '../pu66/lifecycle-service'
import { Pu66ImportRepository } from '../pu66/import-repository'
import { Pu66ImportService } from '../pu66/import-service'
import { InvalidPu66Upload, AmbiguousPu66Key, InvalidPu66Lifecycle } from '../pu66/errors'
import { InvalidPu66Upload as UploadError, applyPu66Upload } from '../pu66-web-import'
import { parsePu66, type Pu66Import } from '../pu66'
import { RevisionConflict } from '../storage-errors'
import { readCard, readEntry } from './pu66-read-fixture'

const connections: DatabaseSync[] = [],
  directories: string[] = []
const now = () => '2030-02-01T12:00:00.000Z'
afterEach(() => {
  for (const db of connections.splice(0).reverse()) db.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})
function setup(path = ':memory:', clock = now) {
  const db = openDatabase(path)
  connections.push(db)
  migrateDatabase(db, { path, now })
  const keys = new Pu66KeyResolver(db),
    cards = new Pu66Repository(db, keys),
    events = new Pu66LifecycleRepository(db, keys, clock),
    transactions = new SqliteTransactionRunner(db),
    lifecycle = new Pu66LifecycleService(cards, events, transactions, clock),
    imports = new Pu66ImportRepository(db, (key) => events.getStatus(key), clock),
    service = new Pu66ImportService(imports, lifecycle, events, transactions)
  return { db, keys, cards, events, transactions, lifecycle, imports, service }
}
function exclude(lifecycle: Pu66LifecycleService, keys: string[]) {
  const input: Pu66LifecycleWrite = {
    action: 'exclude',
    keys,
    date: '2030-01-30',
    actor: 'Учебный специалист',
    reason: 'closed',
    comment: '',
    successorKey: null,
  }
  lifecycle.record(input, lifecycle.plan(input).fingerprint)
}
function snapshot(db: DatabaseSync) {
  return [
    'pu66_sources',
    'pu66_cards',
    'pu66_revisions',
    'pu66_lifecycle',
    'pu66_key_aliases',
    'pu66_verifications',
  ].map((table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())
}
const restorationFor = (entries: Pu66Import[]): Pu66ImportRestore => ({
  keys: entries.map((entry) => entry.card.key),
  date: '2030-01-30',
  actor: 'Учебный специалист',
})

describe('PU-66 import without RegistryStore', () => {
  it('does not initialize or close storage; inspects read-only data using raw keys and existing aliases', () => {
    const empty = new DatabaseSync(':memory:')
    connections.push(empty)
    new Pu66ImportRepository(empty, () => null, now)
    expect(empty.prepare('SELECT name FROM sqlite_master').all()).toEqual([])
    const { db, service, imports } = setup(),
      entry = readEntry(readCard())
    service.record([entry])
    const alias = db.prepare('INSERT INTO pu66_key_aliases VALUES (?, ?)')
    alias.run('old-single', entry.card.key)
    alias.run('ambiguous', null)
    db.exec('PRAGMA query_only = ON')
    expect(imports.inspect([entry])).toMatchObject([{ action: 'unchanged', currentRevision: 1 }])
    const legacy = { ...entry, card: { ...entry.card, key: 'old-single' } }
    expect(imports.inspect([legacy])).toMatchObject([
      {
        referenceId: 'old-single',
        action: 'add',
        currentRevision: 0,
        status: { referenceId: entry.card.key, excluded: false },
      },
    ])
    expect(() =>
      imports.inspect([{ ...legacy, card: { ...legacy.card, key: 'ambiguous' } }]),
    ).toThrow(AmbiguousPu66Key)
    expect(() => imports.write([readEntry(entry.card, 'changed')])).toThrow(/readonly/)
    expect(db.prepare('SELECT COUNT(*) AS count FROM pu66_cards').get()).toEqual({ count: 1 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM normative').get()).toEqual({ count: 0 })
  })

  it('deduplicates exact workbook bytes, truncates only stored names and preserves immutable revisions', () => {
    const { db, service } = setup(),
      first = readEntry(readCard()),
      second = { ...first, filename: 'renamed.xlsx', card: readCard('99999:89:4') }
    first.filename = 'я'.repeat(250) + '.xlsx'
    expect(service.record([first, second])).toEqual({ added: 2, updated: 0, unchanged: 0 })
    expect(db.prepare('SELECT sha256, original_name, workbook FROM pu66_sources').all()).toEqual([
      {
        sha256: first.sha256,
        original_name: first.filename.slice(0, 240),
        workbook: new Uint8Array(first.source),
      },
    ])
    const revision = db.prepare('SELECT * FROM pu66_revisions WHERE key = ?').get(first.card.key),
      changed = readEntry({ ...first.card, roadName: 'Изменённая вымышленная дорога' }, 'changed')
    expect(service.record([changed, second])).toEqual({ added: 0, updated: 1, unchanged: 1 })
    expect(
      db.prepare('SELECT * FROM pu66_revisions WHERE key = ? AND revision = 1').get(first.card.key),
    ).toEqual(revision)
    const before = snapshot(db)
    expect(service.record([changed, second])).toEqual({ added: 0, updated: 0, unchanged: 2 })
    expect(snapshot(db)).toEqual(before)
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  })

  it('keeps preview fingerprint inputs and public whitelist, and wraps only inspection failures', () => {
    const { db, service, lifecycle } = setup(),
      entry = readEntry(readCard()),
      preview = service.preview([entry])
    // Captured from the original planImport on b1d7bfc with this synthetic inspection.
    expect(preview.fingerprint).toBe(
      '419cbb58c07b74bee12198cec52c5a16618568e9fda7344803936a87378c0d0b',
    )
    expect(preview).toMatchObject({ added: 1, updated: 0, unchanged: 0, restored: 0 })
    expect(Object.keys(preview.items[0]!)).toEqual([
      'filename',
      'referenceId',
      'location',
      'roadName',
      'action',
      'currentRevision',
      'status',
    ])
    expect(JSON.stringify(preview)).not.toContain('sourceSha256')
    expect(JSON.stringify(preview)).not.toContain('FICTIONAL-PRIVATE-MARKER')
    expect(service.preview([{ ...entry, sha256: 'f'.repeat(64) }]).fingerprint).not.toBe(
      preview.fingerprint,
    )
    expect(service.preview([{ ...entry, filename: 'other.xlsx' }]).fingerprint).not.toBe(
      preview.fingerprint,
    )
    expect(() => service.preview([entry, entry])).toThrow(InvalidPu66Upload)
    expect(UploadError).toBe(InvalidPu66Upload)
    service.record([entry])
    const active = service.preview([entry])
    exclude(lifecycle, [entry.card.key])
    const excluded = service.preview([entry])
    expect(excluded.fingerprint).not.toBe(active.fingerprint)
    const restoration = restorationFor([entry]),
      before = snapshot(db)
    expect(service.preview([entry], restoration)).toMatchObject({ unchanged: 1, restored: 1 })
    expect(service.preview([entry], restoration).fingerprint).not.toBe(excluded.fingerprint)
    expect(() => service.preview([entry], { ...restoration, date: '9999-01-01' })).toThrow(
      InvalidPu66Lifecycle,
    )
    expect(() => service.preview([entry], { ...restoration, keys: ['missing'] })).toThrow(
      InvalidPu66Upload,
    )
    expect(snapshot(db)).toEqual(before)
  })

  it.each(['revision', 'restore', 'clock'] as const)(
    'rolls back every write after a late %s failure',
    (failure) => {
      let clockCalls = 0,
        failClock = false
      const { db, service, lifecycle, events } = setup(':memory:', () => {
          if (failClock && ++clockCalls === 5) throw new Error('late clock failure')
          return now()
        }),
        entries = [readEntry(readCard()), readEntry(readCard('99999:89:4'))]
      service.record(entries)
      exclude(
        lifecycle,
        entries.map((entry) => entry.card.key),
      )
      const changed = entries.map((entry) => readEntry(entry.card, 'changed')),
        restoration = restorationFor(entries),
        before = snapshot(db)
      if (failure === 'revision')
        db.exec(
          `CREATE TRIGGER reject_revision AFTER INSERT ON pu66_revisions WHEN NEW.key = '99999:89:4' BEGIN SELECT RAISE(ABORT, 'late revision failure'); END`,
        )
      if (failure === 'restore')
        db.exec(
          `CREATE TRIGGER reject_restore AFTER INSERT ON pu66_lifecycle WHEN NEW.action = 'restore' AND NEW.key = '99999:89:4' BEGIN SELECT RAISE(ABORT, 'late restore failure'); END`,
        )
      failClock = failure === 'clock'
      expect(() => service.record(changed, restoration)).toThrow(/late .* failure/)
      expect(db.isTransaction).toBe(false)
      expect(snapshot(db)).toEqual(before)
      expect(events.getStatus(entries[0]!.card.key)?.excluded).toBe(true)
      failClock = false
      if (failure !== 'clock') db.exec(`DROP TRIGGER reject_${failure}`)
      expect(service.record(changed, restoration)).toEqual({ added: 0, updated: 2, unchanged: 0 })
      for (const entry of entries)
        expect(events.getStatus(entry.card.key)?.event).toMatchObject({
          action: 'restore',
          cardRevision: 2,
        })
    },
  )

  it('holds one write lock during restore validation and all writes, with distinct per-card/event times', () => {
    const directory = mkdtempSync(join(tmpdir(), 'tod-import-lock-'))
    directories.push(directory)
    const path = join(directory, 'registry.sqlite')
    let recording = false,
      calls = 0
    const { db, imports, lifecycle, events, transactions, service } = setup(path, () => {
        if (recording) expect(db.isTransaction).toBe(true)
        return `2030-02-01T00:00:00.${String(++calls).padStart(3, '0')}Z`
      }),
      other = openDatabase(path),
      entries = [readEntry(readCard()), readEntry(readCard('99999:89:4'))]
    connections.push(other)
    other.exec('PRAGMA busy_timeout = 1')
    service.record(entries)
    exclude(
      lifecycle,
      entries.map((entry) => entry.card.key),
    )
    let validated = false
    const locked = new Pu66ImportService(
      imports,
      {
        plan(input) {
          validated = true
          expect(db.isTransaction).toBe(true)
          expect(() =>
            other.prepare('UPDATE pu66_cards SET updated_at = ?').run('blocked'),
          ).toThrow(/locked/)
          expect(other.prepare('SELECT COUNT(*) AS count FROM pu66_revisions').get()).toEqual({
            count: 2,
          })
          return lifecycle.plan(input)
        },
      },
      events,
      transactions,
    )
    calls = 0
    recording = true
    locked.record(
      entries.map((entry) => readEntry(entry.card, 'changed')),
      restorationFor(entries),
    )
    expect(validated).toBe(true)
    expect(calls).toBe(5) // lifecycle validation, two changed cards, then two restore events
    expect(events.list(entries[0]!.card.key)?.[0]?.recordedAt).toBe('2030-02-01T00:00:00.004Z')
    expect(events.list(entries[1]!.card.key)?.[0]?.recordedAt).toBe('2030-02-01T00:00:00.005Z')
    expect(other.prepare('SELECT COUNT(*) AS count FROM pu66_revisions').get()).toEqual({
      count: 4,
    })
  })

  it('keeps a narrow upload port, backup failure, post-backup stale preview and unchanged no-backup', async () => {
    const { db, service } = setup(),
      source = await createSampleWorkbook(sampleCards[0]!),
      entry = await parsePu66(source, sampleCards[0]!.filename),
      files = [{ name: entry.filename, data: source.toString('base64') }],
      expectedFingerprint = service.preview([entry]).fingerprint
    let backups = 0,
      writes = 0,
      failBackup = true
    const commands = {
      planPu66Import: (entries: Pu66Import[], restoration: Pu66ImportRestore | null) =>
        service.preview(entries, restoration),
      importPu66: (entries: Pu66Import[], restoration: Pu66ImportRestore | null) => {
        writes++
        return service.record(entries, restoration)
      },
      async createBackup() {
        backups++
        expect(db.isTransaction).toBe(false)
        await Promise.resolve()
        if (failBackup) throw new Error('backup failed')
        service.record([readEntry(entry.card, 'other writer')])
        return 'fictional-backup.sqlite'
      },
    }
    await expect(
      applyPu66Upload(commands, { files, expectedFingerprint: '0'.repeat(64) }),
    ).rejects.toThrow(RevisionConflict)
    expect(backups).toBe(0)
    await expect(applyPu66Upload(commands, { files, expectedFingerprint })).rejects.toThrow(
      'backup failed',
    )
    expect(writes).toBe(0)
    failBackup = false
    await expect(applyPu66Upload(commands, { files, expectedFingerprint })).rejects.toThrow(
      RevisionConflict,
    )
    expect(writes).toBe(0)
    expect(db.prepare('SELECT COUNT(*) AS count FROM pu66_revisions').get()).toEqual({ count: 1 })
    service.record([entry])
    expect(
      await applyPu66Upload(commands, {
        files,
        expectedFingerprint: service.preview([entry]).fingerprint,
      }),
    ).toEqual({ added: 0, updated: 0, unchanged: 1, restored: 0, backup: null })
    expect(backups).toBe(2)
  })
})
