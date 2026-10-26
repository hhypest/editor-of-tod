import type { DatabaseSync } from 'node:sqlite'
import type {
  Pu66LifecycleWrite,
  Pu66Status,
  Pu66ImportRestore,
} from '../../src/domain/pu66-lifecycle.ts'
import type { Pu66KeyResolver } from './key-resolver.ts'

export class Pu66LifecycleRepository {
  private readonly db: DatabaseSync
  private readonly keys: Pick<Pu66KeyResolver, 'resolve'>
  private readonly now: () => string

  constructor(db: DatabaseSync, keys: Pick<Pu66KeyResolver, 'resolve'>, now: () => string) {
    this.db = db
    this.keys = keys
    this.now = now
  }

  getStatus(requestedKey: string): Pu66Status | null {
    const key = this.keys.resolve(requestedKey)
    if (!key) return null
    const event = this.list(key)?.[0] ?? null
    return {
      referenceId: key,
      excluded: event?.action === 'exclude',
      event,
      successorKey: event?.action === 'exclude' ? event.successorKey : null,
    }
  }

  list(requestedKey: string): Array<NonNullable<Pu66Status['event']>> | null {
    const key = this.keys.resolve(requestedKey)
    if (!key) return null
    const rows = this.db
      .prepare(
        `SELECT id, action, date, actor, reason, comment,
      successor_key, card_revision, recorded_at FROM pu66_lifecycle WHERE key = ? ORDER BY id DESC`,
      )
      .all(key) as Array<{
      id: number
      action: 'exclude' | 'restore'
      date: string
      actor: string
      reason: NonNullable<Pu66Status['event']>['reason']
      comment: string
      successor_key: string | null
      card_revision: number
      recorded_at: string
    }>
    return rows.map((row) => ({
      id: row.id,
      action: row.action,
      date: row.date,
      actor: row.actor,
      reason: row.reason,
      comment: row.comment,
      successorKey: row.successor_key,
      cardRevision: row.card_revision,
      recordedAt: row.recorded_at,
    }))
  }

  /** Caller owns the transaction and has rechecked the plan under its write lock. */
  append(
    input: Pu66LifecycleWrite,
    items: ReadonlyArray<{ referenceId: string; revision: number }>,
  ): void {
    const insert = this.db.prepare(`INSERT INTO pu66_lifecycle
        (key, card_revision, action, date, actor, reason, comment, successor_key, recorded_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    const now = this.now()
    for (const item of items) {
      insert.run(
        item.referenceId,
        item.revision,
        input.action,
        input.date,
        input.actor,
        input.action === 'exclude' ? input.reason : null,
        input.comment,
        input.action === 'exclude' ? input.successorKey : null,
        now,
      )
    }
  }

  /** Import owns the transaction; use each newly written card revision and a clock per key. */
  appendImportRestores(restoration: Pu66ImportRestore): void {
    const insert = this.db.prepare(`INSERT INTO pu66_lifecycle
          (key, card_revision, action, date, actor, reason, comment, successor_key, recorded_at)
          SELECT key, revision, 'restore', ?, ?, NULL, 'Возврат при импорте XLSX.', NULL, ?
          FROM pu66_cards WHERE key = ?`)
    for (const key of restoration.keys)
      insert.run(restoration.date, restoration.actor, this.now(), key)
  }
}
