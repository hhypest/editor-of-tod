import type { Migration } from './migration.ts'

export const removeLegacySvg: Migration = {
  from: 2,
  to: 3,
  name: 'remove-svg',
  run({ db }) {
    // A failed VACUUM can be retried on the next launch without losing the PNGs.
    const columns = db.prepare('PRAGMA table_info(signs)').all() as { name: string }[]
    if (columns.some((column) => column.name === 'plain_svg')) {
      db.exec('PRAGMA secure_delete = ON')
      db.exec('BEGIN IMMEDIATE')
      try {
        db.exec('ALTER TABLE signs DROP COLUMN plain_svg')
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    }
    // Rebuild the file so removed vector data is not left in unused SQLite pages.
    db.exec('VACUUM')
    db.exec('PRAGMA user_version = 3')
  },
}
