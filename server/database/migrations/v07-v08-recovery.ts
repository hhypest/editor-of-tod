import type { Migration } from './migration.ts'

export const recoveryDrafts: Migration = {
  from: 7,
  to: 8,
  name: 'recovery',
  run({ db }) {
    db.exec(`
        BEGIN;
        CREATE TABLE IF NOT EXISTS project_recovery (
          session_id TEXT PRIMARY KEY,
          version INTEGER NOT NULL CHECK (version > 0),
          scheme_json TEXT NOT NULL CHECK (json_valid(scheme_json)),
          base_revision INTEGER CHECK (base_revision >= 0),
          details_json TEXT CHECK (details_json IS NULL OR json_valid(details_json)),
          placement_json TEXT CHECK (placement_json IS NULL OR json_valid(placement_json)),
          file_name TEXT NOT NULL,
          reference_id TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        PRAGMA user_version = 8;
        COMMIT;
      `)
  },
}
