import type { Migration } from './migration.ts'

export const pu66Verifications: Migration = {
  from: 4,
  to: 5,
  name: 'pu66-verifications',
  run({ db }) {
    db.exec(`
        BEGIN;
        CREATE TABLE pu66_verifications (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          key TEXT NOT NULL,
          card_revision INTEGER NOT NULL CHECK (card_revision > 0),
          verified_at TEXT NOT NULL,
          verified_by TEXT NOT NULL,
          recorded_at TEXT NOT NULL,
          FOREIGN KEY (key, card_revision) REFERENCES pu66_revisions(key, revision)
        );
        CREATE INDEX pu66_verifications_by_card ON pu66_verifications(key, card_revision, id);
        PRAGMA user_version = 5;
        COMMIT;
      `)
  },
}
