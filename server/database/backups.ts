import { mkdirSync, chmodSync, rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'

export function databaseBackupDirectory(path: string): string {
  return join(dirname(path), 'backups')
}

/** Before-schema copy; v2 deliberately leaves no copy of removed vector data. */
export function createMigrationBackup(
  db: DatabaseSync,
  databasePath: string,
  version: number,
  now: () => string,
): string | null {
  if (version === 2 || databasePath === ':memory:') return null
  const directory = databaseBackupDirectory(databasePath)
  const filename = `registry-before-update-v${version}-${now().replaceAll(':', '-').replaceAll('.', '-')}-${randomUUID().slice(0, 8)}.sqlite`
  const path = join(directory, filename)
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    db.prepare('VACUUM INTO ?').run(path)
    if (process.platform !== 'win32') chmodSync(path, 0o600)
  } catch (error) {
    try {
      rmSync(path, { force: true })
    } catch {
      // An inaccessible backup directory must not hide the original failure.
    }
    throw new Error(
      `Не удалось сохранить копию базы перед обновлением (${error instanceof Error ? error.message : String(error)}). База не изменена: освободите место или проверьте доступ к папке ${directory} и запустите программу снова.`,
    )
  }
  return filename
}

/** User-requested copy retains its existing async facade and error/cleanup policy. */
export async function createManualBackup(
  db: DatabaseSync,
  databasePath: string,
  now: () => string,
): Promise<string> {
  if (databasePath === ':memory:')
    throw new Error('Нельзя сохранить резервную копию базы в памяти.')
  const directory = databaseBackupDirectory(databasePath)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const filename = `registry-${now().replaceAll(':', '-').replaceAll('.', '-')}-${randomUUID().slice(0, 8)}.sqlite`
  const path = join(directory, filename)
  try {
    db.prepare('VACUUM INTO ?').run(path)
    if (process.platform !== 'win32') chmodSync(path, 0o600)
  } catch (error) {
    rmSync(path, { force: true })
    throw error
  }
  return filename
}
