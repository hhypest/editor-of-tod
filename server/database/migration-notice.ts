import { join } from 'node:path'
import { SCHEMA_VERSION } from './schema-version.ts'

export interface MigrationMetadata {
  readonly migratedFrom: number | null
  readonly migrationBackup: string | null
  readonly backupDirectory: string
}

/** Сообщение для окна программы после обновления схемы базы; `null`, если обновления не было. */
export function migrationNotice(store: MigrationMetadata): string | null {
  if (store.migratedFrom === null) return null
  const versions = `База обновлена: версия ${store.migratedFrom} → ${SCHEMA_VERSION}.`
  return store.migrationBackup
    ? `${versions} Прежняя база сохранена: ${join(store.backupDirectory, store.migrationBackup)}`
    : versions
}
