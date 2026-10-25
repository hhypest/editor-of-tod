import type { Migration } from './migration.ts'

export const projectHistory: Migration = {
  from: 3,
  to: 4,
  name: 'projects',
  run({ db }) {
    db.exec(`
        BEGIN;
        CREATE TABLE project_drafts (
          id TEXT PRIMARY KEY,
          revision INTEGER NOT NULL CHECK (revision > 0),
          scheme_json TEXT NOT NULL CHECK (json_valid(scheme_json)),
          reference_id TEXT NOT NULL,
          location_text TEXT NOT NULL,
          template_code TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE project_revisions (
          id TEXT NOT NULL,
          revision INTEGER NOT NULL CHECK (revision > 0),
          scheme_json TEXT NOT NULL CHECK (json_valid(scheme_json)),
          updated_at TEXT NOT NULL,
          PRIMARY KEY (id, revision),
          FOREIGN KEY (id) REFERENCES project_drafts(id)
        );
        PRAGMA user_version = 4;
        COMMIT;
      `)
  },
}
