import type { DatabaseSync } from 'node:sqlite'
import { localCardSummary, schemeFields, normativeFields, type Pu66Card } from '../pu66.ts'
import type { Pu66Verification } from '../../src/domain/pu66-review.ts'
import type { Pu66KeyResolver } from './key-resolver.ts'

export type Pu66Summary = ReturnType<typeof localCardSummary> & {
  revision: number
  updatedAt: string
  verification: Pu66Verification | null
}
export type Pu66Scheme = ReturnType<typeof schemeFields> & { revision: number; updatedAt: string }
export type Pu66Norms = ReturnType<typeof normativeFields> & { revision: number; updatedAt: string }

/** Read projections on the existing connection. Import, verification and lifecycle writes are separate. */
export class Pu66Repository {
  private readonly db: DatabaseSync
  private readonly keys: Pick<Pu66KeyResolver, 'resolve'>

  constructor(db: DatabaseSync, keys: Pick<Pu66KeyResolver, 'resolve'>) {
    this.db = db
    this.keys = keys
  }

  list(includeExcluded = false): Pu66Summary[] {
    const rows = this.db
      .prepare(
        `SELECT c.revision, c.payload_json, c.updated_at,
           v.verified_at, v.verified_by, v.recorded_at
         FROM pu66_cards AS c
         LEFT JOIN pu66_verifications AS v ON v.id = (
           SELECT id FROM pu66_verifications
           WHERE key = c.key AND card_revision = c.revision
           ORDER BY verified_at DESC, id DESC LIMIT 1
         )
         ${
           includeExcluded
             ? ''
             : `WHERE COALESCE((SELECT action FROM pu66_lifecycle
           WHERE key = c.key ORDER BY id DESC LIMIT 1), 'restore') <> 'exclude'`
         }
         ORDER BY c.key`,
      )
      .all() as Array<{
      revision: number
      payload_json: string
      updated_at: string
      verified_at: string | null
      verified_by: string | null
      recorded_at: string | null
    }>
    return rows.map((row) => ({
      ...localCardSummary(JSON.parse(row.payload_json) as Pu66Card),
      revision: row.revision,
      updatedAt: row.updated_at,
      verification:
        row.verified_at && row.verified_by && row.recorded_at
          ? {
              cardRevision: row.revision,
              verifiedAt: row.verified_at,
              verifiedBy: row.verified_by,
              recordedAt: row.recorded_at,
            }
          : null,
    }))
  }

  getScheme(requestedKey: string): Pu66Scheme | null {
    const key = this.keys.resolve(requestedKey)
    if (!key) return null
    const row = this.db
      .prepare('SELECT payload_json, revision, updated_at FROM pu66_cards WHERE key = ?')
      .get(key) as { payload_json: string; revision: number; updated_at: string } | undefined
    return row
      ? {
          ...schemeFields(JSON.parse(row.payload_json) as Pu66Card),
          revision: row.revision,
          updatedAt: row.updated_at,
        }
      : null
  }

  getNorms(requestedKey: string): Pu66Norms | null {
    const key = this.keys.resolve(requestedKey)
    if (!key) return null
    const row = this.db
      .prepare('SELECT payload_json, revision, updated_at FROM pu66_cards WHERE key = ?')
      .get(key) as { payload_json: string; revision: number; updated_at: string } | undefined
    return row
      ? {
          ...normativeFields(JSON.parse(row.payload_json) as Pu66Card),
          revision: row.revision,
          updatedAt: row.updated_at,
        }
      : null
  }
}
