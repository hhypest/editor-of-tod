import type { Migration } from './migration.ts'

export const normativeDocuments: Migration = {
  from: 9,
  to: 10,
  name: 'documents',
  run({ db }) {
    db.exec(`
        BEGIN;
        CREATE TABLE IF NOT EXISTS normative_documents (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          code TEXT NOT NULL,
          edition TEXT NOT NULL,
          title TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('signs', 'rules', 'methodology', 'other')),
          effective_from TEXT NOT NULL,
          amends_id INTEGER REFERENCES normative_documents(id),
          note TEXT NOT NULL,
          actual_checked_at TEXT NOT NULL,
          filename TEXT NOT NULL,
          pdf BLOB NOT NULL,
          sha256 TEXT NOT NULL UNIQUE,
          size_bytes INTEGER NOT NULL,
          added_at TEXT NOT NULL
        );
        COMMIT;
      `)
    const columns = db.prepare('PRAGMA table_info(sign_catalog_batches)').all() as Array<{
      name: string
    }>
    if (!columns.some((column) => column.name === 'document_id'))
      db.exec(
        'ALTER TABLE sign_catalog_batches ADD COLUMN document_id INTEGER REFERENCES normative_documents(id)',
      )
    db.exec('PRAGMA user_version = 10')
  },
}
