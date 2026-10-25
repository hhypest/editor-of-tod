import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { RECOVERY_LEASE_MS, recoveryIsActive } from '../../src/application/recovery-session.ts'
import { schemeSchema, type Scheme } from '../../src/domain/model.ts'
import { MAX_LOCAL_PROJECT_BYTES } from '../../src/domain/local-projects.ts'
import {
  recoveryRecordSchema,
  recoverySummarySchema,
  type RecoveryRecord,
  type RecoverySummary,
  type RecoveryWrite,
} from '../../src/domain/recovery.ts'
import { RecoveryOwned, RevisionConflict, ProjectTooLarge } from '../storage-errors.ts'
import type { ProjectSourceStore } from '../projects/project-source-store.ts'

export type RecoverySaveInput = Omit<RecoveryWrite, 'scheme'> & { scheme: unknown }
export type SaveRecovery = { input: RecoverySaveInput; ownerId: string; sourceSha256?: string }
export type OwnedRecovery = { sessionId: string; ownerId: string }
export type ClaimRecovery = OwnedRecovery & { expectedVersion: number }
export type DeleteRecovery = { sessionId: string; expectedVersion: number; ownerId?: string }

/** Atomic recovery commands on the existing connection; no HTTP, lifecycle or migrations. */
export class RecoveryRepository {
  private readonly db: DatabaseSync
  private readonly sources: Pick<ProjectSourceStore, 'encode' | 'decode' | 'removeUnreferenced'>
  private readonly now: () => string

  constructor(
    db: DatabaseSync,
    sources: Pick<ProjectSourceStore, 'encode' | 'decode' | 'removeUnreferenced'>,
    now: () => string,
  ) {
    this.db = db
    this.sources = sources
    this.now = now
  }

  list(): RecoverySummary[] {
    return this.db
      .prepare(
        `SELECT session_id AS sessionId, version, base_revision AS baseRevision,
          file_name AS fileName, reference_id AS referenceId, updated_at AS updatedAt,
          owner_until AS ownerUntil
          FROM project_recovery ORDER BY updated_at DESC`,
      )
      .all()
      .map((row) => {
        const { ownerUntil, ...summary } = row
        return recoverySummarySchema.parse({
          ...summary,
          active: recoveryIsActive(Number(ownerUntil), Date.parse(this.now())),
        })
      })
  }

  get(sessionId: string, access?: { ownerId?: string }): RecoveryRecord | null {
    const row = this.db
      .prepare('SELECT * FROM project_recovery WHERE session_id = ?')
      .get(sessionId) as
      | {
          version: number
          owner_id: string | null
          owner_until: number
          scheme_json: string
          base_revision: number | null
          details_json: string | null
          placement_json: string | null
          file_name: string
          updated_at: string
        }
      | undefined
    if (
      access &&
      row &&
      row.owner_id !== access.ownerId &&
      recoveryIsActive(row.owner_until, Date.parse(this.now()))
    )
      throw new RecoveryOwned()
    return row
      ? recoveryRecordSchema.parse({
          sessionId,
          version: row.version,
          scheme: this.sources.decode(row.scheme_json),
          baseRevision: row.base_revision,
          detailsDraft: row.details_json === null ? null : JSON.parse(row.details_json),
          placementDraft: row.placement_json === null ? null : JSON.parse(row.placement_json),
          fileName: row.file_name,
          updatedAt: row.updated_at,
        })
      : null
  }

  /** Compatibility read guard; callers mutate only through atomic commands. */
  assertAvailable(sessionId: string, ownerId?: string): void {
    const row = this.db
      .prepare('SELECT owner_id, owner_until FROM project_recovery WHERE session_id = ?')
      .get(sessionId) as { owner_id: string | null; owner_until: number } | undefined
    if (
      row &&
      row.owner_id !== ownerId &&
      recoveryIsActive(row.owner_until, Date.parse(this.now()))
    )
      throw new RecoveryOwned()
  }

  claim({ sessionId, ownerId, expectedVersion }: ClaimRecovery): RecoveryRecord {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.assertAvailable(sessionId, ownerId)
      const record = this.get(sessionId)
      if (!record || record.version !== expectedVersion) throw new RevisionConflict()
      this.db
        .prepare(
          'UPDATE project_recovery SET owner_id = ?, owner_until = ?, version = version + 1 WHERE session_id = ?',
        )
        .run(ownerId, Date.parse(this.now()) + RECOVERY_LEASE_MS, sessionId)
      this.db.exec('COMMIT')
      return { ...record, version: record.version + 1 }
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  renew({ sessionId, ownerId }: OwnedRecovery): void {
    const result = this.db
      .prepare('UPDATE project_recovery SET owner_until = ? WHERE session_id = ? AND owner_id = ?')
      .run(Date.parse(this.now()) + RECOVERY_LEASE_MS, sessionId, ownerId)
    if (!result.changes) throw new RecoveryOwned()
  }

  release({ sessionId, ownerId }: OwnedRecovery): void {
    this.db
      .prepare('UPDATE project_recovery SET owner_until = 0 WHERE session_id = ? AND owner_id = ?')
      .run(sessionId, ownerId)
  }

  /** Compatibility resolver; save always invokes it under its transaction. */
  resolveScheme(sessionId: string, value: unknown, sourceSha256?: string): Scheme {
    if (!sourceSha256) return schemeSchema.parse(value)
    // References only reuse the source already attached to this copy, never another project's data.
    const previous = this.get(sessionId)
    if (previous?.scheme.source.kind !== 'legacy-html-v1') throw new RevisionConflict()
    const originalJson = previous.scheme.source.originalJson
    if (createHash('sha256').update(originalJson, 'utf8').digest('hex') !== sourceSha256)
      throw new RevisionConflict()
    if (!value || typeof value !== 'object' || !('source' in value)) throw new RevisionConflict()
    const source = value.source
    if (
      !source ||
      typeof source !== 'object' ||
      !('kind' in source) ||
      source.kind !== 'legacy-html-v1' ||
      'originalJson' in source
    )
      throw new RevisionConflict()
    return schemeSchema.parse({ ...value, source: { ...source, originalJson } })
  }

  save({ input: transfer, ownerId, sourceSha256 }: SaveRecovery): RecoveryRecord {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      // The old HTTP assert/resolve/save sequence is now protected by this one write lock.
      this.assertAvailable(transfer.sessionId, ownerId)
      const scheme = this.resolveScheme(transfer.sessionId, transfer.scheme, sourceSha256)
      const input = { ...transfer, scheme }
      const payload = JSON.stringify(input)
      if (Buffer.byteLength(payload) > MAX_LOCAL_PROJECT_BYTES) throw new ProjectTooLarge()
      const existing = this.db
        .prepare('SELECT version, owner_id FROM project_recovery WHERE session_id = ?')
        .get(input.sessionId) as { version: number; owner_id: string | null } | undefined
      this.assertAvailable(input.sessionId, ownerId)
      if (existing?.owner_id && existing.owner_id !== ownerId) throw new RecoveryOwned()
      if ((existing?.version ?? 0) !== input.expectedVersion) throw new RevisionConflict()
      const version = input.expectedVersion + 1
      const updatedAt = this.now()
      this.db
        .prepare(
          `INSERT INTO project_recovery
            (session_id, version, scheme_json, base_revision, details_json, placement_json,
              file_name, reference_id, updated_at, owner_id, owner_until)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(session_id) DO UPDATE SET
              version = excluded.version, scheme_json = excluded.scheme_json,
              base_revision = excluded.base_revision, details_json = excluded.details_json,
              placement_json = excluded.placement_json, file_name = excluded.file_name,
              reference_id = excluded.reference_id, updated_at = excluded.updated_at,
              owner_id = excluded.owner_id, owner_until = excluded.owner_until`,
        )
        .run(
          input.sessionId,
          version,
          this.sources.encode(input.scheme),
          input.baseRevision,
          input.detailsDraft === null ? null : JSON.stringify(input.detailsDraft),
          input.placementDraft === null ? null : JSON.stringify(input.placementDraft),
          input.fileName,
          input.scheme.crossing.referenceId,
          updatedAt,
          ownerId,
          Date.parse(updatedAt) + RECOVERY_LEASE_MS,
        )
      this.db.exec('COMMIT')
      const { expectedVersion: _expectedVersion, ...record } = input
      void _expectedVersion
      return { ...record, version, updatedAt }
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  delete({ sessionId, expectedVersion, ownerId }: DeleteRecovery): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.assertAvailable(sessionId, ownerId)
      const existing = this.db
        .prepare('SELECT version, scheme_json FROM project_recovery WHERE session_id = ?')
        .get(sessionId) as { version: number; scheme_json: string } | undefined
      if (!existing || existing.version !== expectedVersion) throw new RevisionConflict()
      this.db.prepare('DELETE FROM project_recovery WHERE session_id = ?').run(sessionId)
      this.sources.removeUnreferenced(existing.scheme_json)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }
}
