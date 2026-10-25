import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { parseStoredScheme, type Scheme } from '../../src/domain/model.ts'

/** SQLite-only source projection. The caller owns the connection and transaction. */
export class ProjectSourceStore {
  private readonly db: DatabaseSync

  constructor(db: DatabaseSync) {
    this.db = db
  }

  /** The JSON export stays self-contained; only SQLite snapshots use a content reference. */
  decode(payload: string): Scheme {
    const stored = JSON.parse(payload) as {
      source?: { kind?: string; originalJsonSha256?: unknown }
    }
    if (stored.source?.kind !== 'legacy-html-v1' || !('originalJsonSha256' in stored.source)) {
      return parseStoredScheme(stored)
    }
    const sha256 = stored.source.originalJsonSha256
    if (typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256)) {
      throw new Error(
        'Ссылка на исходный файл проекта повреждена. Восстановите проект из резервной копии.',
      )
    }
    const row = this.db
      .prepare('SELECT original_json FROM project_sources WHERE sha256 = ?')
      .get(sha256) as { original_json: string } | undefined
    if (!row || createHash('sha256').update(row.original_json, 'utf8').digest('hex') !== sha256) {
      throw new Error(
        'Исходный файл проекта отсутствует или повреждён. Восстановите проект из резервной копии.',
      )
    }
    const { originalJsonSha256: _hash, ...source } = stored.source
    void _hash
    return parseStoredScheme({
      ...stored,
      source: { ...source, originalJson: row.original_json },
    })
  }

  encode(scheme: Scheme): string {
    if (scheme.source.kind !== 'legacy-html-v1') return JSON.stringify(scheme)
    const { originalJson, ...source } = scheme.source
    const sha256 = createHash('sha256').update(originalJson, 'utf8').digest('hex')
    this.db
      .prepare(
        'INSERT INTO project_sources (sha256, original_json) VALUES (?, ?) ON CONFLICT(sha256) DO NOTHING',
      )
      .run(sha256, originalJson)
    return JSON.stringify({ ...scheme, source: { ...source, originalJsonSha256: sha256 } })
  }

  /** Call after removing a reference, inside the same write transaction. */
  removeUnreferenced(payload: string): void {
    const stored = JSON.parse(payload) as {
      source?: { originalJsonSha256?: unknown }
    }
    const sha256 = stored.source?.originalJsonSha256
    if (typeof sha256 === 'string') {
      const referenced = this.db
        .prepare(
          `SELECT 1 FROM (
            SELECT scheme_json FROM project_drafts
            UNION ALL SELECT scheme_json FROM project_revisions
            UNION ALL SELECT scheme_json FROM project_recovery
          ) WHERE json_extract(scheme_json, '$.source.originalJsonSha256') = ? LIMIT 1`,
        )
        .get(sha256)
      if (!referenced) this.db.prepare('DELETE FROM project_sources WHERE sha256 = ?').run(sha256)
    }
  }
}
