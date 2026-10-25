import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openDatabase } from '../database/connection'
import { migrateDatabase } from '../database/migration-runner'
import { readSchemaVersion, SCHEMA_VERSION } from '../database/schema-version'

const directories: string[] = []
const connections: DatabaseSync[] = []
const now = () => '2030-01-02T03:04:05.000Z'
const sql = (version: number) =>
  readFileSync(`tests/fixtures/frozen/databases/registry-v${version}.sql`, 'utf8')
afterEach(() => {
  vi.restoreAllMocks()
  for (const db of connections.splice(0)) db.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function fixture(version: number, memory = false) {
  const directory = mkdtempSync(join(tmpdir(), 'tod-migration-runner-'))
  directories.push(directory)
  const path = memory ? ':memory:' : join(directory, 'registry.sqlite')
  const db = openDatabase(path)
  connections.push(db)
  if (version === 1 || version === 2) {
    db.exec(sql(3))
    if (version === 1)
      db.exec(
        'DROP TABLE signs; DROP TABLE pu66_revisions; DROP TABLE pu66_cards; DROP TABLE pu66_sources; PRAGMA user_version = 1',
      )
    else {
      db.exec('ALTER TABLE signs ADD COLUMN plain_svg TEXT; PRAGMA user_version = 2')
      db.prepare('UPDATE signs SET plain_svg = ?').run('fictional-v2-vector-marker')
    }
  } else if (version > 0) db.exec(sql(version))
  return { directory, path, db, options: { path, now } }
}

describe('migration runner independently of RegistryStore', () => {
  it('refuses an outer transaction without rolling back work owned by its caller', () => {
    const { db, options } = fixture(12)
    db.exec(
      "BEGIN; INSERT INTO revisions VALUES ('crossings', 'fictional-pending', 1, '{}', '2030-01-01')",
    )
    expect(() => migrateDatabase(db, options)).toThrow('внутри открытой транзакции')
    expect(db.isTransaction).toBe(true)
    expect(db.prepare("SELECT key FROM revisions WHERE key = 'fictional-pending'").get()).toEqual({
      key: 'fictional-pending',
    })
    db.exec('ROLLBACK')
  })

  it.each([0, 1, 2, 12, 13])(
    'upgrades schema %i with the original branch and backup policy',
    (version) => {
      const { directory, path, db, options } = fixture(version)
      const result = migrateDatabase(db, options)
      expect(readSchemaVersion(db)).toBe(SCHEMA_VERSION)
      expect(result.migratedFrom).toBe(version > 0 && version < 13 ? version : null)
      const backupRequired = version > 0 && version < 13 && version !== 2
      expect(result.migrationBackup !== null).toBe(backupRequired)
      if (result.migrationBackup) {
        const backup = new DatabaseSync(join(directory, 'backups', result.migrationBackup), {
          readOnly: true,
        })
        try {
          expect(readSchemaVersion(backup)).toBe(version)
        } finally {
          backup.close()
        }
      } else expect(existsSync(join(directory, 'backups'))).toBe(false)
      const stable = readFileSync(path)
      const exec = vi.spyOn(db, 'exec')
      expect(migrateDatabase(db, options)).toEqual({ migratedFrom: null, migrationBackup: null })
      expect(exec).not.toHaveBeenCalled()
      expect(readFileSync(path)).toEqual(stable)
      // The runner neither seeds domain data nor owns/terminates the connection.
      expect(db.prepare('SELECT COUNT(*) AS count FROM normative').get()).toEqual({
        count: version === 0 ? 0 : 4,
      })
    },
  )

  it('migrates an in-memory schema without requesting a file copy or clock value', () => {
    const { db, path } = fixture(12, true)
    const clock = vi.fn(() => {
      throw new Error('Memory-only migration must not create a filename')
    })
    expect(migrateDatabase(db, { path, now: clock })).toEqual({
      migratedFrom: 12,
      migrationBackup: null,
    })
    expect(readSchemaVersion(db)).toBe(13)
    expect(clock).not.toHaveBeenCalled()
  })

  it('rejects a future schema before invoking backup and leaves the file and connection usable', () => {
    const { directory, path, db } = fixture(0)
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`)
    const before = readFileSync(path)
    const clock = vi.fn(now)
    expect(() => migrateDatabase(db, { path, now: clock })).toThrow(
      'Неизвестная версия локальной базы',
    )
    expect(clock).not.toHaveBeenCalled()
    expect(readFileSync(path)).toEqual(before)
    expect(existsSync(join(directory, 'backups'))).toBe(false)
    expect(readSchemaVersion(db)).toBe(14)
  })

  it('does not change the schema when its required backup fails', () => {
    const { directory, path, db, options } = fixture(12)
    writeFileSync(join(directory, 'backups'), 'fictional blocked directory')
    const before = readFileSync(path)
    expect(() => migrateDatabase(db, options)).toThrow(
      'Не удалось сохранить копию базы перед обновлением',
    )
    expect(readSchemaVersion(db)).toBe(12)
    expect(readFileSync(path)).toEqual(before)
  })

  it('rolls back the unfinished step, preserves its backup and permits a retry on the same connection', () => {
    const { directory, db, options } = fixture(12)
    const failure = new Error('fictional interrupted migration')
    const exec = db.exec
    vi.spyOn(db, 'exec').mockImplementationOnce(() => {
      exec.call(db, 'BEGIN; ALTER TABLE project_recovery ADD COLUMN owner_id TEXT')
      throw failure
    })
    expect(() => migrateDatabase(db, options)).toThrow(failure)
    expect(readSchemaVersion(db)).toBe(12)
    expect(db.isTransaction).toBe(false)
    expect(
      (db.prepare('PRAGMA table_info(project_recovery)').all() as { name: string }[]).some(
        (column) => column.name === 'owner_id',
      ),
    ).toBe(false)
    const backups = readdirSync(join(directory, 'backups'))
    expect(backups).toHaveLength(1)
    const backup = new DatabaseSync(join(directory, 'backups', backups[0]!), { readOnly: true })
    try {
      expect(readSchemaVersion(backup)).toBe(12)
    } finally {
      backup.close()
    }
    expect(migrateDatabase(db, options).migratedFrom).toBe(12)
    expect(readSchemaVersion(db)).toBe(13)
  })

  it('rejects a step that did not reach its declared version instead of reporting an upgrade', () => {
    const { db, options } = fixture(12)
    vi.spyOn(db, 'exec').mockImplementationOnce(() => undefined)
    expect(() => migrateDatabase(db, options)).toThrow('не установила версию 13: получена 12')
    expect(readSchemaVersion(db)).toBe(12)
  })

  it('retries v2 after a failed out-of-transaction VACUUM without preserving removed SVG data in a backup', () => {
    const { directory, path, db, options } = fixture(2)
    const exec = db.exec
    let failed = false
    vi.spyOn(db, 'exec').mockImplementation((statement) => {
      if (statement === 'VACUUM' && !failed) {
        failed = true
        expect(db.isTransaction).toBe(false)
        throw new Error('fictional VACUUM failure')
      }
      return exec.call(db, statement)
    })
    expect(() => migrateDatabase(db, options)).toThrow('fictional VACUUM failure')
    expect(readSchemaVersion(db)).toBe(2)
    expect(existsSync(join(directory, 'backups'))).toBe(false)
    expect(migrateDatabase(db, options)).toEqual({ migratedFrom: 2, migrationBackup: null })
    expect(readSchemaVersion(db)).toBe(13)
    expect(existsSync(join(directory, 'backups'))).toBe(false)
    expect(readFileSync(path).includes(Buffer.from('fictional-v2-vector-marker'))).toBe(false)
  })
})
