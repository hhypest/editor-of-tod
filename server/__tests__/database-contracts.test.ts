import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { RegistryStore, SCHEMA_VERSION } from '../store'

const directories: string[] = []
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('database lifecycle through the stable RegistryStore facade', () => {
  it('keeps the injected clock receiver when delegating manual and migration backup', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'tod-backup-clock-'))
    directories.push(directory)
    const path = join(directory, 'registry.sqlite')
    function clock(this: RegistryStore) {
      expect(this).toBeInstanceOf(RegistryStore)
      expect(this.path).toBe(path)
      return '2030-01-02T03:04:05.000Z'
    }
    const original = new RegistryStore(path, clock)
    try {
      expect(await original.createBackup()).toMatch(/^registry-2030-01-02/)
    } finally {
      original.close()
    }
    const raw = new DatabaseSync(path)
    raw.exec(
      'ALTER TABLE project_recovery DROP COLUMN owner_until; ALTER TABLE project_recovery DROP COLUMN owner_id; PRAGMA user_version = 12',
    )
    raw.close()
    const reopened = new RegistryStore(path, clock)
    try {
      expect(reopened.migrationBackup).toMatch(/^registry-before-update-v12-2030-01-02/)
    } finally {
      reopened.close()
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
      expect(() => new RegistryStore(path)).toThrow('Неизвестная версия локальной базы')
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
