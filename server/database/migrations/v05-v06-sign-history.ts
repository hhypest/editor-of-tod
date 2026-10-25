import type { Migration } from './migration.ts'

export const signHistory: Migration = {
  from: 5,
  to: 6,
  name: 'sign-history',
  run({ db }) {
    db.exec(`
        BEGIN;
        CREATE TABLE IF NOT EXISTS sign_catalog_batches (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          document_code TEXT NOT NULL,
          edition TEXT NOT NULL,
          pdf_sha256 TEXT,
          zip_sha256 TEXT NOT NULL,
          sign_count INTEGER NOT NULL,
          imported_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS sign_active (
          code TEXT PRIMARY KEY REFERENCES signs(code),
          batch_id INTEGER REFERENCES sign_catalog_batches(id)
        );
        CREATE TABLE IF NOT EXISTS sign_revisions (
          code TEXT NOT NULL,
          revision INTEGER NOT NULL,
          numbered_png BLOB NOT NULL,
          plain_png BLOB NOT NULL,
          numbered_sha256 TEXT NOT NULL,
          plain_sha256 TEXT NOT NULL,
          zip_sha256 TEXT NOT NULL,
          batch_id INTEGER REFERENCES sign_catalog_batches(id),
          active INTEGER NOT NULL CHECK (active IN (0, 1)),
          updated_at TEXT NOT NULL,
          PRIMARY KEY (code, revision)
        );
        INSERT OR IGNORE INTO sign_active (code, batch_id) SELECT code, NULL FROM signs;
        INSERT OR IGNORE INTO sign_revisions
          (code, revision, numbered_png, plain_png, numbered_sha256, plain_sha256,
           zip_sha256, batch_id, active, updated_at)
          SELECT code, revision, numbered_png, plain_png, numbered_sha256, plain_sha256,
                 zip_sha256, NULL, 1, updated_at FROM signs;
        PRAGMA user_version = 6;
        COMMIT;
      `)
  },
}
