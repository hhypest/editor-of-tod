import { closeSync, constants, existsSync, mkdirSync, openSync, chmodSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/** Opens one connection with the existing local-file policy; no migrations or domain SQL. */
export function openDatabase(path: string): DatabaseSync {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    if (!existsSync(path))
      closeSync(openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR, 0o600))
    if (process.platform !== 'win32') chmodSync(path, 0o600)
  }
  const db = new DatabaseSync(path, { allowExtension: false, defensive: true, timeout: 3_000 })
  try {
    db.exec('PRAGMA foreign_keys = ON')
    return db
  } catch (error) {
    db.close()
    throw error
  }
}
