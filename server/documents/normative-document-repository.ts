import type { DatabaseSync } from 'node:sqlite'
import type { DocumentMeta, DocumentRecord } from '../../src/domain/normative-documents.ts'

export class NormativeDocumentRepository {
  private readonly db: DatabaseSync
  private readonly now: () => string

  constructor(db: DatabaseSync, now: () => string) {
    this.db = db
    this.now = now
  }

  private documentRow(row: Record<string, unknown>): DocumentRecord {
    return {
      id: Number(row.id),
      code: String(row.code),
      edition: String(row.edition),
      title: String(row.title),
      kind: row.kind as DocumentRecord['kind'],
      effectiveFrom: String(row.effective_from),
      amendsId: row.amends_id === null ? null : Number(row.amends_id),
      note: String(row.note),
      actualCheckedAt: String(row.actual_checked_at),
      filename: String(row.filename),
      sha256: String(row.sha256),
      sizeBytes: Number(row.size_bytes),
      addedAt: String(row.added_at),
    }
  }

  /** Библиотека нормативных документов без содержимого PDF. */
  list(): DocumentRecord[] {
    return (
      this.db
        .prepare(
          `SELECT id, code, edition, title, kind, effective_from, amends_id, note,
                  actual_checked_at, filename, sha256, size_bytes, added_at
             FROM normative_documents ORDER BY code, effective_from, id`,
        )
        .all() as Record<string, unknown>[]
    ).map((row) => this.documentRow(row))
  }

  get(id: number): DocumentRecord | null {
    return this.list().find((document) => document.id === id) ?? null
  }

  getPdf(id: number): { filename: string; pdf: Uint8Array } | null {
    const row = this.db
      .prepare('SELECT filename, pdf FROM normative_documents WHERE id = ?')
      .get(id) as { filename: string; pdf: Uint8Array } | undefined
    return row ?? null
  }

  findBySha(sha256: string): DocumentRecord | null {
    return this.list().find((document) => document.sha256 === sha256) ?? null
  }

  insert(meta: DocumentMeta, filename: string, pdf: Uint8Array, sha256: string): DocumentRecord {
    const row = this.db
      .prepare(
        `INSERT INTO normative_documents
          (code, edition, title, kind, effective_from, amends_id, note, actual_checked_at,
           filename, pdf, sha256, size_bytes, added_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      )
      .get(
        meta.code,
        meta.edition,
        meta.title,
        meta.kind,
        meta.effectiveFrom,
        meta.amendsId,
        meta.note,
        meta.actualCheckedAt,
        filename,
        pdf,
        sha256,
        pdf.byteLength,
        this.now(),
      ) as { id: number }
    return this.get(row.id)!
  }

  update(id: number, meta: DocumentMeta): DocumentRecord | null {
    this.db
      .prepare(
        `UPDATE normative_documents SET code = ?, edition = ?, title = ?, kind = ?,
           effective_from = ?, amends_id = ?, note = ?, actual_checked_at = ? WHERE id = ?`,
      )
      .run(
        meta.code,
        meta.edition,
        meta.title,
        meta.kind,
        meta.effectiveFrom,
        meta.amendsId,
        meta.note,
        meta.actualCheckedAt,
        id,
      )
    return this.get(id)
  }

  /** Caller owns the transaction and has checked all historical references. */
  delete(id: number): void {
    this.db.prepare('DELETE FROM normative_documents WHERE id = ?').run(id)
  }
}
