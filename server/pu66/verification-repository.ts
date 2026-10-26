import type { DatabaseSync } from 'node:sqlite'
import {
  localCalendarDate,
  pu66VerificationWriteSchema,
  type Pu66Verification,
  type Pu66VerificationWrite,
} from '../../src/domain/pu66-review.ts'
import type { Pu66KeyResolver } from './key-resolver.ts'
import { InvalidPu66Lifecycle, InvalidPu66Verification } from './errors.ts'
import { RevisionConflict } from '../storage-errors.ts'

/** The existing lifecycle query runs on the same connection inside record's transaction. */
export type Pu66VerificationStatusQuery = (key: string) => { excluded: boolean } | null

export class Pu66VerificationRepository {
  private readonly db: DatabaseSync
  private readonly keys: Pick<Pu66KeyResolver, 'resolve'>
  private readonly getStatus: Pu66VerificationStatusQuery
  private readonly now: () => string

  constructor(
    db: DatabaseSync,
    keys: Pick<Pu66KeyResolver, 'resolve'>,
    getStatus: Pu66VerificationStatusQuery,
    now: () => string,
  ) {
    this.db = db
    this.keys = keys
    this.getStatus = getStatus
    this.now = now
  }

  record(requestedKey: string, input: Pu66VerificationWrite): Pu66Verification | null {
    const { expectedRevision, verifiedAt, verifiedBy } = pu66VerificationWriteSchema.parse(input)
    const key = this.keys.resolve(requestedKey)
    if (!key) return null
    const now = this.now()
    if (verifiedAt > localCalendarDate(new Date(now))) throw new InvalidPu66Verification()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const current = this.db.prepare('SELECT revision FROM pu66_cards WHERE key = ?').get(key) as
        { revision: number } | undefined
      if (!current) {
        this.db.exec('ROLLBACK')
        return null
      }
      if (current.revision !== expectedRevision) throw new RevisionConflict()
      if (this.getStatus(key)?.excluded)
        throw new InvalidPu66Lifecycle(
          'Карточка исключена: верните её в действующие перед сверкой.',
        )
      this.db
        .prepare(
          `INSERT INTO pu66_verifications (key, card_revision, verified_at, verified_by, recorded_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(key, current.revision, verifiedAt, verifiedBy, now)
      this.db.exec('COMMIT')
      return { cardRevision: current.revision, verifiedAt, verifiedBy, recordedAt: now }
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  list(requestedKey: string): Pu66Verification[] | null {
    const key = this.keys.resolve(requestedKey)
    if (!key) return null
    const rows = this.db
      .prepare(
        `SELECT card_revision, verified_at, verified_by, recorded_at
         FROM pu66_verifications WHERE key = ? ORDER BY id DESC`,
      )
      .all(key) as Array<{
      card_revision: number
      verified_at: string
      verified_by: string
      recorded_at: string
    }>
    return rows.map((row) => ({
      cardRevision: row.card_revision,
      verifiedAt: row.verified_at,
      verifiedBy: row.verified_by,
      recordedAt: row.recorded_at,
    }))
  }
}
