import type { DatabaseSync } from 'node:sqlite'
import type { Pu66Status } from '../../src/domain/pu66-lifecycle.ts'
import type { Pu66Import } from '../pu66.ts'

export type Pu66ImportCounts = { added: number; updated: number; unchanged: number }
export type Pu66ImportItem = {
  filename: string
  referenceId: string
  location: string
  roadName: string
  action: 'add' | 'update' | 'unchanged'
  currentRevision: number
  sourceSha256: string
  status: Pu66Status | null
}

export class Pu66ImportRepository {
  private readonly db: DatabaseSync
  private readonly getStatus: (key: string) => Pu66Status | null
  private readonly now: () => string

  constructor(db: DatabaseSync, getStatus: (key: string) => Pu66Status | null, now: () => string) {
    this.db = db
    this.getStatus = getStatus
    this.now = now
  }

  inspect(entries: Pu66Import[]): Pu66ImportItem[] {
    const seen = new Set<string>()
    const existing = this.db.prepare('SELECT revision, source_sha256 FROM pu66_cards WHERE key = ?')
    const result: Pu66ImportItem[] = []
    for (const entry of entries) {
      if (seen.has(entry.card.key)) throw new Error(`Повторный ключ ПУ-66: ${entry.card.key}.`)
      seen.add(entry.card.key)
      const previous = existing.get(entry.card.key) as
        { revision: number; source_sha256: string } | undefined
      result.push({
        filename: entry.filename,
        referenceId: entry.card.key,
        location: `${entry.card.kilometre} км ${entry.card.picket} пк`,
        roadName: entry.card.roadName,
        action: !previous
          ? 'add'
          : previous.source_sha256 === entry.sha256
            ? 'unchanged'
            : 'update',
        currentRevision: previous?.revision ?? 0,
        sourceSha256: entry.sha256,
        status: this.getStatus(entry.card.key),
      })
    }
    return result
  }

  /** Caller owns the transaction spanning sources, cards, revisions and restore events. */
  write(entries: Pu66Import[]): void {
    const source = this.db.prepare(
      'INSERT OR IGNORE INTO pu66_sources (sha256, original_name, workbook) VALUES (?, ?, ?)',
    )
    const current = this.db.prepare(
      `INSERT INTO pu66_cards (key, revision, payload_json, source_sha256, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET revision=excluded.revision, payload_json=excluded.payload_json,
         source_sha256=excluded.source_sha256, updated_at=excluded.updated_at`,
    )
    const revisionInsert = this.db.prepare(
      `INSERT INTO pu66_revisions (key, revision, payload_json, source_sha256, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
    )
    const previousQuery = this.db.prepare(
      'SELECT revision, source_sha256 FROM pu66_cards WHERE key = ?',
    )
    for (const entry of entries) {
      const previous = previousQuery.get(entry.card.key) as
        { revision: number; source_sha256: string } | undefined
      if (previous?.source_sha256 === entry.sha256) continue
      source.run(entry.sha256, entry.filename.slice(0, 240), entry.source)
      const revision = (previous?.revision ?? 0) + 1
      const updatedAt = this.now()
      const payload = JSON.stringify(entry.card)
      current.run(entry.card.key, revision, payload, entry.sha256, updatedAt)
      revisionInsert.run(entry.card.key, revision, payload, entry.sha256, updatedAt)
    }
  }
}
