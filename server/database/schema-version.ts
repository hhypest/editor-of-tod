import type { DatabaseSync } from 'node:sqlite'

export const SCHEMA_VERSION = 13

export function readSchemaVersion(db: DatabaseSync): number {
  return (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
}
