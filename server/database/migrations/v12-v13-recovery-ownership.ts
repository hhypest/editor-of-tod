import type { Migration } from './migration.ts'

export const recoveryOwnership: Migration = {
  from: 12,
  to: 13,
  name: 'recovery-ownership',
  run({ db }) {
    db.exec(`
          BEGIN;
          ALTER TABLE project_recovery ADD COLUMN owner_id TEXT;
          ALTER TABLE project_recovery ADD COLUMN owner_until INTEGER NOT NULL DEFAULT 0;
          PRAGMA user_version = 13;
          COMMIT;
        `)
  },
}
