import type { Migration } from './migration.ts'

export const pu66Lifecycle: Migration = {
  from: 11,
  to: 12,
  name: 'pu66-lifecycle',
  run({ db }) {
    db.exec(`
          BEGIN;
          CREATE TABLE IF NOT EXISTS pu66_lifecycle (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            key TEXT NOT NULL,
            card_revision INTEGER NOT NULL,
            action TEXT NOT NULL CHECK (action IN ('exclude', 'restore')),
            date TEXT NOT NULL,
            actor TEXT NOT NULL,
            reason TEXT,
            comment TEXT NOT NULL,
            successor_key TEXT REFERENCES pu66_cards(key),
            recorded_at TEXT NOT NULL,
            FOREIGN KEY (key, card_revision) REFERENCES pu66_revisions(key, revision)
          );
          CREATE INDEX IF NOT EXISTS pu66_lifecycle_by_card ON pu66_lifecycle(key, id);
          PRAGMA user_version = 12;
          COMMIT;
        `)
  },
}
