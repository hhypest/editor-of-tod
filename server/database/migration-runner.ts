import type { DatabaseSync } from 'node:sqlite'
import { createMigrationBackup } from './backups.ts'
import { migrations } from './migrations/index.ts'
import { readSchemaVersion, SCHEMA_VERSION } from './schema-version.ts'

export interface MigrationResult {
  migratedFrom: number | null
  migrationBackup: string | null
}

/** The caller owns the connection; a failed migration is rolled back before returning control. */
export function migrateDatabase(
  db: DatabaseSync,
  options: { path: string; now: () => string },
): MigrationResult {
  // Migrations own their original transaction boundaries, including out-of-transaction VACUUM.
  if (db.isTransaction) throw new Error('Миграции нельзя выполнять внутри открытой транзакции.')
  try {
    const version = readSchemaVersion(db)
    if (!Number.isInteger(version) || version < 0 || version > SCHEMA_VERSION)
      throw new Error(`Неизвестная версия локальной базы: ${version}. Файл не изменён.`)

    const migratedFrom = version > 0 && version < SCHEMA_VERSION ? version : null
    const migrationBackup =
      migratedFrom === null ? null : createMigrationBackup(db, options.path, version, options.now)
    let current = version
    while (current < SCHEMA_VERSION) {
      const migration = migrations.find((item) => item.from === current)
      if (!migration || migration.to <= current || migration.to > SCHEMA_VERSION)
        throw new Error(`Не найден переход локальной базы из версии ${current}.`)
      migration.run({ db })
      const reached = readSchemaVersion(db)
      if (reached !== migration.to)
        throw new Error(
          `Миграция ${migration.name} не установила версию ${migration.to}: получена ${reached}.`,
        )
      current = reached
    }
    return { migratedFrom, migrationBackup }
  } catch (error) {
    // Keep the original SQLite/backup failure; v2 VACUUM intentionally runs outside a transaction.
    try {
      db.exec('ROLLBACK')
    } catch {
      /* No transaction was active. */
    }
    throw error
  }
}
