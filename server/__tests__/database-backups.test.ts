import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openDatabase } from '../database/connection'
import {
  createManualBackup,
  createMigrationBackup,
  databaseBackupDirectory,
} from '../database/backups'

const directories: string[] = []
const connections: DatabaseSync[] = []
const now = () => '2030-01-02T03:04:05.000Z'
afterEach(() => {
  vi.restoreAllMocks()
  for (const db of connections.splice(0)) db.close()
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true })
})

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'tod-backup-boundary-'))
  directories.push(directory)
  const path = join(directory, 'private-data', 'registry.sqlite')
  const db = openDatabase(path)
  connections.push(db)
  db.exec(
    "CREATE TABLE marker (value TEXT); INSERT INTO marker VALUES ('fictional'); PRAGMA user_version = 12",
  )
  return { db, path, directory: databaseBackupDirectory(path) }
}

describe('database backup boundary', () => {
  it('copies the current schema/data with distinct manual/migration names and keeps the source usable', async () => {
    const { db, path, directory } = fixture()
    const before = readFileSync(path)
    const migration = createMigrationBackup(db, path, 12, now)!
    const manual = await createManualBackup(db, path, now)
    expect(migration).toMatch(
      /^registry-before-update-v12-2030-01-02T03-04-05-000Z-[a-f0-9]{8}\.sqlite$/,
    )
    expect(manual).toMatch(/^registry-2030-01-02T03-04-05-000Z-[a-f0-9]{8}\.sqlite$/)
    expect(readdirSync(directory).sort()).toEqual([migration, manual].sort())
    for (const name of [migration, manual]) {
      const copy = new DatabaseSync(join(directory, name), { readOnly: true })
      try {
        expect(copy.prepare('PRAGMA user_version').get()).toEqual({ user_version: 12 })
        expect(copy.prepare('SELECT value FROM marker').get()).toEqual({ value: 'fictional' })
        if (process.platform !== 'win32')
          expect(statSync(join(directory, name)).mode & 0o777).toBe(0o600)
      } finally {
        copy.close()
      }
    }
    expect(readFileSync(path)).toEqual(before)
    expect(db.prepare('SELECT value FROM marker').get()).toEqual({ value: 'fictional' })
  })

  it('skips migration copies for v2/memory and refuses manual backup of a memory-only database', async () => {
    const { db, path, directory } = fixture()
    expect(createMigrationBackup(db, path, 2, now)).toBeNull()
    expect(existsSync(directory)).toBe(false)
    const memory = openDatabase(':memory:')
    connections.push(memory)
    expect(createMigrationBackup(memory, ':memory:', 12, now)).toBeNull()
    await expect(createManualBackup(memory, ':memory:', now)).rejects.toThrow('базы в памяти')
    expect(memory.prepare('SELECT 1 AS alive').get()).toEqual({ alive: 1 })
  })

  it.each(['migration', 'manual'])(
    'removes a partial %s copy without altering the source or closing it',
    async (kind) => {
      const { db, path, directory } = fixture()
      const before = readFileSync(path)
      const failure = new Error('fictional disk failure')
      const statement = db.prepare('VACUUM INTO ?')
      vi.spyOn(statement, 'run').mockImplementation((destination) => {
        writeFileSync(String(destination), 'fictional partial copy')
        throw failure
      })
      vi.spyOn(db, 'prepare').mockReturnValueOnce(statement)
      const copy =
        kind === 'manual'
          ? createManualBackup(db, path, now)
          : Promise.resolve().then(() => createMigrationBackup(db, path, 12, now))
      if (kind === 'manual') await expect(copy).rejects.toBe(failure)
      else
        await expect(copy).rejects.toThrow(
          'Не удалось сохранить копию базы перед обновлением (fictional disk failure)',
        )
      expect(readdirSync(directory)).toEqual([])
      expect(readFileSync(path)).toEqual(before)
      expect(db.prepare('SELECT value FROM marker').get()).toEqual({ value: 'fictional' })
    },
  )
})
