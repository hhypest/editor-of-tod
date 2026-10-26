import { openTestApplication } from './test-application'
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SCHEMA_VERSION } from '../database/schema-version'

const directories: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('database lifecycle through initialized storage owners', () => {
  it('closes after a seed failure, preserving earlier committed entries and the original error', () => {
    const directory = mkdtempSync(join(tmpdir(), 'tod-seed-failure-'))
    directories.push(directory)
    const path = join(directory, 'registry.sqlite')
    const failure = new Error('fictional second seed failure')
    let calls = 0
    const close = vi.spyOn(DatabaseSync.prototype, 'close')
    expect(() =>
      openTestApplication(path, () => {
        if (++calls === 2) throw failure
        return '2030-01-02T03:04:05.000Z'
      }),
    ).toThrow(failure)
    expect(close).toHaveBeenCalledTimes(1)
    const closed = close.mock.contexts[0] as DatabaseSync
    expect(() => closed.prepare('SELECT 1')).toThrow()
    const reopened = openTestApplication(path, () => {
      throw new Error('A nonempty registry must not be seeded again')
    })
    try {
      expect(reopened.runtime.schemaVersion()).toBe(SCHEMA_VERSION)
      const records = reopened.legacy.listNormative()
      expect(records).toHaveLength(1)
      expect(reopened.legacy.history('normative', records[0]!.id)).toHaveLength(1)
    } finally {
      reopened.runtime.close()
    }
  })

  it('closes after migration failure and can retry after repairing the synthetic schema', () => {
    const directory = mkdtempSync(join(tmpdir(), 'tod-migration-failure-'))
    directories.push(directory)
    const path = join(directory, 'registry.sqlite')
    const raw = new DatabaseSync(path)
    raw.exec(readFileSync('tests/fixtures/frozen/databases/registry-v12.sql', 'utf8'))
    raw.exec('ALTER TABLE project_recovery ADD COLUMN owner_id TEXT')
    raw.close()
    const close = vi.spyOn(DatabaseSync.prototype, 'close')
    expect(() => openTestApplication(path)).toThrow(/duplicate column name: owner_id/)
    expect(close).toHaveBeenCalledTimes(1)
    const closed = close.mock.contexts[0] as DatabaseSync
    expect(() => closed.prepare('SELECT 1')).toThrow()
    const repair = new DatabaseSync(path)
    try {
      expect(repair.prepare('PRAGMA user_version').get()).toEqual({ user_version: 12 })
      repair.exec('ALTER TABLE project_recovery DROP COLUMN owner_id')
    } finally {
      repair.close()
    }
    const reopened = openTestApplication(path)
    try {
      expect(reopened.runtime.migratedFrom).toBe(12)
      expect(reopened.runtime.schemaVersion()).toBe(SCHEMA_VERSION)
    } finally {
      reopened.runtime.close()
    }
  })

  it('keeps the injected clock receiver when delegating manual and migration backup', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'tod-backup-clock-'))
    directories.push(directory)
    const path = join(directory, 'registry.sqlite')
    const clockContext = { path: path }
    function clock(this: typeof clockContext) {
      expect(this).toBe(clockContext)
      expect(this.path).toBe(path)
      return '2030-01-02T03:04:05.000Z'
    }
    const original = openTestApplication(path, clock.bind(clockContext))
    try {
      expect(await original.runtime.http.createBackup()).toMatch(/^registry-2030-01-02/)
    } finally {
      original.runtime.close()
    }
    const raw = new DatabaseSync(path)
    raw.exec(
      'ALTER TABLE project_recovery DROP COLUMN owner_until; ALTER TABLE project_recovery DROP COLUMN owner_id; PRAGMA user_version = 12',
    )
    raw.close()
    const reopened = openTestApplication(path, clock.bind(clockContext))
    try {
      expect(reopened.runtime.migrationBackup).toMatch(/^registry-before-update-v12-2030-01-02/)
    } finally {
      reopened.runtime.close()
    }
  })

  it('rejects a future schema without changing bytes, creating a backup or retaining the handle', () => {
    const directory = mkdtempSync(join(tmpdir(), 'tod-future-schema-'))
    directories.push(directory)
    const path = join(directory, 'registry.sqlite')
    const raw = new DatabaseSync(path)
    raw.exec(
      `CREATE TABLE marker (value TEXT); INSERT INTO marker VALUES ('fictional'); PRAGMA user_version = ${SCHEMA_VERSION + 1}`,
    )
    raw.close()
    const before = readFileSync(path)
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(() => openTestApplication(path)).toThrow('Неизвестная версия локальной базы')
      expect(readFileSync(path)).toEqual(before)
      expect(existsSync(join(directory, 'backups'))).toBe(false)
    }
    const reopened = new DatabaseSync(path)
    try {
      expect(reopened.prepare('SELECT value FROM marker').get()).toEqual({ value: 'fictional' })
    } finally {
      reopened.close()
    }
  })
})
