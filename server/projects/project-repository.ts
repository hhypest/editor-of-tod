import type { DatabaseSync } from 'node:sqlite'
import { schemeSchema, type Scheme } from '../../src/domain/model.ts'
import {
  MAX_LOCAL_PROJECT_BYTES,
  type ProjectRecord,
  type ProjectRevision,
  type ProjectSummary,
} from '../../src/domain/local-projects.ts'
import { RevisionConflict, ProjectTooLarge } from '../storage-errors.ts'
import type { ProjectSourceStore } from './project-source-store.ts'

type ProjectRow = { revision: number; updated_at: string; scheme_json: string }

/**
 * Поле последней редакции проекта для списка «Мои проекты»: по нему составитель узнаёт
 * проект (место по ПУ-66, дорога, направления, описание работ). Не строка — пустая строка.
 */
function summaryText(path: string): string {
  return `CASE WHEN json_type(scheme_json, '${path}') = 'text'
    THEN substr(json_extract(scheme_json, '${path}'), 1, 500) ELSE '' END`
}

/** Формат записанного снимка проекта: редакции в базе не переписываются при обновлении. */
function storedVersion(payload: string): { storedSchemaVersion?: number } {
  const version = (JSON.parse(payload) as { schemaVersion?: unknown }).schemaVersion
  return Number.isInteger(version) && (version as number) > 0
    ? { storedSchemaVersion: version as number }
    : {}
}

/** Atomic project/history operations on the caller-owned connection. No migration or HTTP. */
export class ProjectRepository {
  private readonly db: DatabaseSync
  private readonly sources: Pick<ProjectSourceStore, 'encode' | 'decode'>
  private readonly now: () => string

  constructor(
    db: DatabaseSync,
    sources: Pick<ProjectSourceStore, 'encode' | 'decode'>,
    now: () => string,
  ) {
    this.db = db
    this.sources = sources
    this.now = now
  }

  list(): ProjectSummary[] {
    return this.db
      .prepare(
        `SELECT id, reference_id AS referenceId, location_text AS locationText,
          template_code AS templateCode, revision, updated_at AS updatedAt,
          ${summaryText('$.crossing.snapshot.location')} AS crossingLocation,
          ${summaryText('$.crossing.snapshot.roadName')} AS roadName,
          ${summaryText('$.parameters.directions.left')} AS directionLeft,
          ${summaryText('$.parameters.directions.right')} AS directionRight,
          ${summaryText('$.titleBlock.work.description')} AS workDescription
          FROM project_drafts ORDER BY updated_at DESC, id`,
      )
      .all() as ProjectSummary[]
  }

  get(id: string): ProjectRecord | null {
    const row = this.db
      .prepare('SELECT revision, scheme_json, updated_at FROM project_drafts WHERE id = ?')
      .get(id) as ProjectRow | undefined
    return row
      ? {
          scheme: this.sources.decode(row.scheme_json),
          revision: row.revision,
          updatedAt: row.updated_at,
          ...storedVersion(row.scheme_json),
        }
      : null
  }

  listRevisions(id: string): ProjectRevision[] {
    return this.db
      .prepare(
        `SELECT revision, updated_at AS updatedAt FROM project_revisions
          WHERE id = ? ORDER BY revision DESC`,
      )
      .all(id) as ProjectRevision[]
  }

  getRevision(id: string, revision: number): ProjectRecord | null {
    const row = this.db
      .prepare(
        'SELECT revision, scheme_json, updated_at FROM project_revisions WHERE id = ? AND revision = ?',
      )
      .get(id, revision) as ProjectRow | undefined
    return row
      ? {
          scheme: this.sources.decode(row.scheme_json),
          revision: row.revision,
          updatedAt: row.updated_at,
          ...storedVersion(row.scheme_json),
        }
      : null
  }

  save(scheme: Scheme, expectedRevision: number, forceRevision = false): ProjectRecord {
    const checked = schemeSchema.parse(scheme)
    const payload = JSON.stringify(checked)
    if (Buffer.byteLength(payload) > MAX_LOCAL_PROJECT_BYTES) throw new ProjectTooLarge()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const previous = this.db
        .prepare('SELECT revision, scheme_json, updated_at FROM project_drafts WHERE id = ?')
        .get(checked.id) as ProjectRow | undefined
      if ((previous?.revision ?? 0) !== expectedRevision) throw new RevisionConflict()
      // Снимок прежнего формата переписывается даже без правок: иначе после «Сохранить проект»
      // база сохранила бы прежний формат и сообщения о нём повторялись бы при каждом открытии.
      if (
        !forceRevision &&
        previous &&
        storedVersion(previous.scheme_json).storedSchemaVersion === checked.schemaVersion &&
        JSON.stringify(this.sources.decode(previous.scheme_json)) === payload
      ) {
        this.db.exec('COMMIT')
        return { scheme: checked, revision: previous.revision, updatedAt: previous.updated_at }
      }
      const revision = expectedRevision + 1
      const updatedAt = this.now()
      const storedPayload = this.sources.encode(checked)
      this.db
        .prepare(
          `INSERT INTO project_drafts
            (id, revision, scheme_json, reference_id, location_text, template_code, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET revision = excluded.revision,
              scheme_json = excluded.scheme_json, reference_id = excluded.reference_id,
              location_text = excluded.location_text, template_code = excluded.template_code,
              updated_at = excluded.updated_at`,
        )
        .run(
          checked.id,
          revision,
          storedPayload,
          checked.crossing.referenceId,
          checked.parameters.locationText,
          checked.template.code,
          updatedAt,
        )
      this.db
        .prepare(
          'INSERT INTO project_revisions (id, revision, scheme_json, updated_at) VALUES (?, ?, ?, ?)',
        )
        .run(checked.id, revision, storedPayload, updatedAt)
      this.db.exec('COMMIT')
      return { scheme: checked, revision, updatedAt }
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  restore(id: string, sourceRevision: number, expectedRevision: number): ProjectRecord | null {
    const previous = this.getRevision(id, sourceRevision)
    return previous ? this.save(previous.scheme, expectedRevision, true) : null
  }
}
