import type { DatabaseSync } from 'node:sqlite'
import {
  crossingDraftSchema,
  normativeDraftSchema,
  type CrossingDraft,
  type CrossingRecord,
  type NormativeDraft,
  type NormativeRecord,
} from '../../src/domain/registry.ts'
import { RevisionConflict } from '../storage-errors.ts'

export type LegacyRegistryKind = 'crossings' | 'normative'
type StoredRow = { key: string; revision: number; payload_json: string; updated_at: string }

/** Manual registries and their history on the caller-owned connection; no seeds or lifecycle. */
export class LegacyRegistryRepository {
  private readonly db: DatabaseSync
  private readonly now: () => string

  constructor(db: DatabaseSync, now: () => string) {
    this.db = db
    this.now = now
  }

  private rows(kind: LegacyRegistryKind): StoredRow[] {
    return this.db
      .prepare(`SELECT key, revision, payload_json, updated_at FROM ${kind} ORDER BY key`)
      .all() as StoredRow[]
  }

  private save(
    kind: LegacyRegistryKind,
    key: string,
    payload: CrossingDraft | NormativeDraft,
    expectedRevision: number,
  ): StoredRow {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const previous = this.db.prepare(`SELECT revision FROM ${kind} WHERE key = ?`).get(key) as
        { revision: number } | undefined
      if ((previous?.revision ?? 0) !== expectedRevision) throw new RevisionConflict()
      const revision = expectedRevision + 1
      const updatedAt = this.now()
      const json = JSON.stringify(payload)
      this.db
        .prepare(
          `INSERT INTO ${kind} (key, revision, payload_json, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET revision = excluded.revision, payload_json = excluded.payload_json, updated_at = excluded.updated_at`,
        )
        .run(key, revision, json, updatedAt)
      this.db
        .prepare(
          'INSERT INTO revisions (kind, key, revision, payload_json, updated_at) VALUES (?, ?, ?, ?, ?)',
        )
        .run(kind, key, revision, json, updatedAt)
      this.db.exec('COMMIT')
      return { key, revision, payload_json: json, updated_at: updatedAt }
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  listCrossings(): CrossingRecord[] {
    return this.rows('crossings').map((row) => ({
      ...crossingDraftSchema.parse(JSON.parse(row.payload_json)),
      revision: row.revision,
      updatedAt: row.updated_at,
    }))
  }

  saveCrossing(draft: CrossingDraft, expectedRevision: number): CrossingRecord {
    const parsed = crossingDraftSchema.parse(draft)
    const row = this.save('crossings', parsed.referenceId, parsed, expectedRevision)
    return { ...parsed, revision: row.revision, updatedAt: row.updated_at }
  }

  listNormative(): NormativeRecord[] {
    return this.rows('normative').map((row) => ({
      ...normativeDraftSchema.parse(JSON.parse(row.payload_json)),
      revision: row.revision,
      updatedAt: row.updated_at,
    }))
  }

  saveNormative(draft: NormativeDraft, expectedRevision: number): NormativeRecord {
    const parsed = normativeDraftSchema.parse(draft)
    const row = this.save('normative', parsed.id, parsed, expectedRevision)
    return { ...parsed, revision: row.revision, updatedAt: row.updated_at }
  }

  history(
    kind: LegacyRegistryKind,
    key: string,
  ): { revision: number; payload: unknown; updatedAt: string }[] {
    return (
      this.db
        .prepare(
          'SELECT revision, payload_json, updated_at FROM revisions WHERE kind = ? AND key = ? ORDER BY revision',
        )
        .all(kind, key) as Omit<StoredRow, 'key'>[]
    ).map((row) => ({
      revision: row.revision,
      payload: JSON.parse(row.payload_json),
      updatedAt: row.updated_at,
    }))
  }
}
