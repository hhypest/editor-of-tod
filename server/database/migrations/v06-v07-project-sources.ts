import type { Migration } from './migration.ts'

export const projectSources: Migration = {
  from: 6,
  to: 7,
  name: 'project-sources',
  run({ db }) {
    db.exec(`
        BEGIN;
        CREATE TABLE project_sources (
          sha256 TEXT PRIMARY KEY,
          original_json TEXT NOT NULL
        );
        PRAGMA user_version = 7;
        COMMIT;
      `)
  },
}
