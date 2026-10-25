import type { Migration } from './migration.ts'

export const documentText: Migration = {
  from: 10,
  to: 11,
  name: 'document-text',
  run({ db }) {
    db.exec(`
        BEGIN;
        CREATE TABLE IF NOT EXISTS document_pages (
          document_id INTEGER NOT NULL REFERENCES normative_documents(id),
          page INTEGER NOT NULL,
          text TEXT NOT NULL,
          PRIMARY KEY (document_id, page)
        );
        CREATE TABLE IF NOT EXISTS parameter_confirmations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          parameter_id TEXT NOT NULL,
          document_id INTEGER REFERENCES normative_documents(id),
          document_label TEXT NOT NULL,
          clause TEXT NOT NULL,
          page INTEGER,
          quote TEXT NOT NULL,
          fragment TEXT NOT NULL,
          value_json TEXT NOT NULL,
          confirmed_by TEXT NOT NULL,
          confirmed_at TEXT NOT NULL,
          note TEXT NOT NULL,
          recorded_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS parameter_confirmations_by_parameter
          ON parameter_confirmations(parameter_id, id);
        PRAGMA user_version = 11;
        COMMIT;
      `)
  },
}
