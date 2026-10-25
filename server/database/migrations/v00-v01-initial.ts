import type { Migration } from './migration.ts'

export const initialSchema: Migration = {
  from: 0,
  to: 1,
  name: 'initial',
  run({ db }) {
    db.exec(`
        BEGIN;
        CREATE TABLE crossings (
          key TEXT PRIMARY KEY,
          revision INTEGER NOT NULL CHECK (revision > 0),
          payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
          updated_at TEXT NOT NULL
        );
        CREATE TABLE normative (
          key TEXT PRIMARY KEY,
          revision INTEGER NOT NULL CHECK (revision > 0),
          payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
          updated_at TEXT NOT NULL
        );
        CREATE TABLE revisions (
          kind TEXT NOT NULL CHECK (kind IN ('crossings', 'normative')),
          key TEXT NOT NULL,
          revision INTEGER NOT NULL,
          payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
          updated_at TEXT NOT NULL,
          PRIMARY KEY (kind, key, revision)
        );
        PRAGMA user_version = 1;
        COMMIT;
      `)
  },
}
