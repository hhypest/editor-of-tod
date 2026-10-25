import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openDatabase } from '../database/connection'

const directories: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('local database connection boundary', () => {
  it('creates a private file without migrating, preserves contents on reopening and releases the handle', () => {
    const directory = mkdtempSync(join(tmpdir(), 'tod-connection-'))
    directories.push(directory)
    const parent = join(directory, 'private-data')
    const path = join(parent, 'registry.sqlite')
    const db = openDatabase(path)
    try {
      expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 0 })
      expect(db.prepare('SELECT name FROM sqlite_master').all()).toEqual([])
      db.exec("CREATE TABLE marker (value TEXT); INSERT INTO marker VALUES ('fictional')")
      if (process.platform !== 'win32') {
        expect(statSync(parent).mode & 0o777).toBe(0o700)
        expect(statSync(path).mode & 0o777).toBe(0o600)
      }
      expect(existsSync(join(parent, 'backups'))).toBe(false)
    } finally {
      db.close()
    }
    expect(() => db.prepare('SELECT 1')).toThrow()
    const reopened = openDatabase(path)
    try {
      expect(reopened.prepare('SELECT value FROM marker').get()).toEqual({ value: 'fictional' })
    } finally {
      reopened.close()
    }
  })

  it('enforces foreign keys and refuses to enable extension loading on an in-memory connection', () => {
    const db = openDatabase(':memory:')
    try {
      db.exec(
        'CREATE TABLE parent (id INTEGER PRIMARY KEY); CREATE TABLE child (parent_id REFERENCES parent(id))',
      )
      expect(() => db.exec('INSERT INTO child VALUES (999)')).toThrow(/FOREIGN KEY/)
      expect(() => db.enableLoadExtension(true)).toThrow(/disabled at database creation/)
      db.exec('INSERT INTO parent VALUES (999); INSERT INTO child VALUES (999)')
      expect(db.prepare('SELECT COUNT(*) AS count FROM child').get()).toEqual({ count: 1 })
    } finally {
      db.close()
    }
  })

  it('closes a connection if its initialization fails and preserves the original error', () => {
    const failure = new Error('fictional initialization failure')
    vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementationOnce(() => {
      throw failure
    })
    const close = vi.spyOn(DatabaseSync.prototype, 'close')
    expect(() => openDatabase(':memory:')).toThrow(failure)
    expect(close).toHaveBeenCalledTimes(1)
    const closed = close.mock.contexts[0]
    if (!(closed instanceof DatabaseSync)) throw new Error('Expected the closed SQLite connection')
    expect(() => closed.prepare('SELECT 1')).toThrow()
  })
})
