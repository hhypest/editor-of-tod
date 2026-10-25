import type { Migration } from './migration.ts'

// Historical v8 shape/selector stay independent of later PU-66 model changes.
type LegacyStationCard = { cardNumber: string }
const legacyStationKey = /^ст\.[^:]*:[^:]+:[^:]+$/

export const stationPu66Keys: Migration = {
  from: 8,
  to: 9,
  name: 'station-keys',
  run({ db }) {
    db.exec('BEGIN')
    db.exec('CREATE TABLE IF NOT EXISTS pu66_key_aliases (old_key TEXT PRIMARY KEY, new_key TEXT)')
    const rows = db
      .prepare(
        `SELECT key, revision, payload_json, source_sha256, updated_at
         FROM pu66_revisions ORDER BY key, revision`,
      )
      .all() as Array<{
      key: string
      revision: number
      payload_json: string
      source_sha256: string
      updated_at: string
    }>
    const byOldKey = new Map<string, typeof rows>()
    for (const row of rows) {
      if (!legacyStationKey.test(row.key)) continue
      byOldKey.set(row.key, [...(byOldKey.get(row.key) ?? []), row])
    }
    const insertRevision = db.prepare(
      `INSERT INTO pu66_revisions (key, revision, payload_json, source_sha256, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    const moveVerifications = db.prepare(
      'UPDATE pu66_verifications SET key = ?, card_revision = ? WHERE key = ? AND card_revision = ?',
    )
    const deleteRevision = db.prepare('DELETE FROM pu66_revisions WHERE key = ? AND revision = ?')
    const insertCard = db.prepare(
      `INSERT INTO pu66_cards (key, revision, payload_json, source_sha256, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    const alias = db.prepare(
      'INSERT OR REPLACE INTO pu66_key_aliases (old_key, new_key) VALUES (?, ?)',
    )
    db.exec('PRAGMA defer_foreign_keys = ON')
    for (const [oldKey, history] of byOldKey) {
      const next = new Map<string, number>()
      const latest = new Map<string, (typeof rows)[number] & { newRevision: number }>()
      for (const row of history) {
        const card = JSON.parse(row.payload_json) as LegacyStationCard
        const newKey = `${oldKey}:к${card.cardNumber}`
        const newRevision = (next.get(newKey) ?? 0) + 1
        next.set(newKey, newRevision)
        const payload = JSON.stringify({ ...card, key: newKey })
        insertRevision.run(newKey, newRevision, payload, row.source_sha256, row.updated_at)
        moveVerifications.run(newKey, newRevision, oldKey, row.revision)
        deleteRevision.run(oldKey, row.revision)
        latest.set(newKey, { ...row, payload_json: payload, newRevision })
      }
      db.prepare('DELETE FROM pu66_cards WHERE key = ?').run(oldKey)
      for (const [newKey, row] of latest) {
        insertCard.run(newKey, row.newRevision, row.payload_json, row.source_sha256, row.updated_at)
      }
      alias.run(oldKey, latest.size === 1 ? [...latest.keys()][0]! : null)
    }
    db.exec('PRAGMA user_version = 9')
    db.exec('COMMIT')
  },
}
