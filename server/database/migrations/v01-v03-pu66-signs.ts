import type { Migration } from './migration.ts'

export const pu66AndSigns: Migration = {
  from: 1,
  to: 3,
  name: 'pu66-signs',
  run({ db }) {
    db.exec(`
        BEGIN;
        CREATE TABLE pu66_sources (
          sha256 TEXT PRIMARY KEY,
          original_name TEXT NOT NULL,
          workbook BLOB NOT NULL
        );
        CREATE TABLE pu66_cards (
          key TEXT PRIMARY KEY,
          revision INTEGER NOT NULL,
          payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
          source_sha256 TEXT NOT NULL REFERENCES pu66_sources(sha256),
          updated_at TEXT NOT NULL
        );
        CREATE TABLE pu66_revisions (
          key TEXT NOT NULL,
          revision INTEGER NOT NULL,
          payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
          source_sha256 TEXT NOT NULL REFERENCES pu66_sources(sha256),
          updated_at TEXT NOT NULL,
          PRIMARY KEY (key, revision)
        );
        CREATE TABLE signs (
          code TEXT PRIMARY KEY,
          numbered_png BLOB NOT NULL,
          plain_png BLOB NOT NULL,
          numbered_sha256 TEXT NOT NULL,
          plain_sha256 TEXT NOT NULL,
          zip_sha256 TEXT NOT NULL,
          width INTEGER NOT NULL,
          height INTEGER NOT NULL,
          revision INTEGER NOT NULL,
          updated_at TEXT NOT NULL
        );
        PRAGMA user_version = 3;
        COMMIT;
      `)
  },
}
