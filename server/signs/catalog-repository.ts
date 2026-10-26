import type { DatabaseSync } from 'node:sqlite'
import type { SignImport } from '../signs.ts'

export type SignCatalogSource = {
  documentCode: string
  edition: string
  pdfSha256: string | null
  /** Документ локальной библиотеки, если архив сверен с прикреплённым PDF. */
  documentId?: number | null
}

export type SignCatalogPlan = {
  added: number
  /** Изменённые изображения и знаки, у которых сменился только источник. */
  updated: number
  unchanged: number
  retired: number
  /** Из `updated`: изображение то же, изменилась только редакция источника. */
  relabelled: number
  addedCodes: string[]
  changedCodes: string[]
  retiredCodes: string[]
}

const unspecifiedSignSource: SignCatalogSource = {
  documentCode: 'Источник не указан',
  edition: 'не указана',
  pdfSha256: null,
}

export class SignCatalogRepository {
  private readonly db: DatabaseSync
  private readonly now: () => string

  constructor(db: DatabaseSync, now: () => string) {
    this.db = db
    this.now = now
  }

  latest(): {
    id: number
    documentCode: string
    edition: string
    pdfSha256: string | null
    zipSha256: string
    signCount: number
    importedAt: string
    documentId: number | null
  } | null {
    const row = this.db
      .prepare(
        `SELECT id, document_code, edition, pdf_sha256, zip_sha256, sign_count, imported_at,
                document_id FROM sign_catalog_batches ORDER BY id DESC LIMIT 1`,
      )
      .get() as
      | {
          id: number
          document_code: string
          edition: string
          pdf_sha256: string | null
          zip_sha256: string
          sign_count: number
          imported_at: string
          document_id: number | null
        }
      | undefined
    return row
      ? {
          id: row.id,
          documentCode: row.document_code,
          edition: row.edition,
          pdfSha256: row.pdf_sha256,
          zipSha256: row.zip_sha256,
          signCount: row.sign_count,
          importedAt: row.imported_at,
          documentId: row.document_id,
        }
      : null
  }

  plan(entries: SignImport[], source: SignCatalogSource = unspecifiedSignSource): SignCatalogPlan {
    const seen = new Set<string>()
    const result: SignCatalogPlan = {
      added: 0,
      updated: 0,
      unchanged: 0,
      retired: 0,
      relabelled: 0,
      addedCodes: [],
      changedCodes: [],
      retiredCodes: [],
    }
    const latest = this.latest()
    const sameSource =
      latest === null
        ? source.documentCode === unspecifiedSignSource.documentCode &&
          source.edition === unspecifiedSignSource.edition &&
          source.pdfSha256 === null
        : latest.documentCode === source.documentCode &&
          latest.edition === source.edition &&
          latest.pdfSha256 === source.pdfSha256
    const existing = this.db.prepare(
      `SELECT s.numbered_sha256, s.plain_sha256, a.code AS active
         FROM signs s LEFT JOIN sign_active a ON a.code = s.code WHERE s.code = ?`,
    )
    for (const entry of entries) {
      if (seen.has(entry.code)) throw new Error(`Повторный код знака: ${entry.code}.`)
      seen.add(entry.code)
      const previous = existing.get(entry.code) as
        { numbered_sha256: string; plain_sha256: string; active: string | null } | undefined
      const samePng =
        previous?.numbered_sha256 === entry.numberedSha256 &&
        previous.plain_sha256 === entry.plainSha256
      if (!previous || !previous.active) {
        result.added++
        result.addedCodes.push(entry.code)
      } else if (samePng && sameSource) result.unchanged++
      else {
        result.updated++
        if (samePng) result.relabelled++
        else result.changedCodes.push(entry.code)
      }
    }
    const active = this.db.prepare('SELECT code FROM sign_active').all() as { code: string }[]
    result.retiredCodes = active.filter(({ code }) => !seen.has(code)).map(({ code }) => code)
    result.retired = result.retiredCodes.length
    return result
  }

  import(
    entries: SignImport[],
    source: SignCatalogSource = unspecifiedSignSource,
  ): SignCatalogPlan {
    const result = this.plan(entries, source)
    if (result.added + result.updated + result.retired === 0) return result
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const batch = this.db
        .prepare(
          `INSERT INTO sign_catalog_batches
          (document_code, edition, pdf_sha256, zip_sha256, sign_count, imported_at, document_id)
          VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
        )
        .get(
          source.documentCode,
          source.edition,
          source.pdfSha256,
          entries[0]?.zipSha256 ?? '',
          entries.length,
          this.now(),
          source.documentId ?? null,
        ) as { id: number }
      const existing = this.db.prepare(
        'SELECT numbered_sha256, plain_sha256, revision FROM signs WHERE code = ?',
      )
      const lastActivity = this.db.prepare(
        'SELECT active FROM sign_revisions WHERE code = ? ORDER BY revision DESC LIMIT 1',
      )
      const save = this.db.prepare(
        `INSERT INTO signs (code, numbered_png, plain_png, numbered_sha256, plain_sha256,
          zip_sha256, width, height, revision, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(code) DO UPDATE SET numbered_png=excluded.numbered_png, plain_png=excluded.plain_png,
          numbered_sha256=excluded.numbered_sha256,
          plain_sha256=excluded.plain_sha256, zip_sha256=excluded.zip_sha256, width=excluded.width,
          height=excluded.height, revision=excluded.revision, updated_at=excluded.updated_at`,
      )
      const revision = this.db.prepare(
        `INSERT INTO sign_revisions
          (code, revision, numbered_png, plain_png, numbered_sha256, plain_sha256,
           zip_sha256, batch_id, active, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      this.db.exec('DELETE FROM sign_active')
      const activate = this.db.prepare('INSERT INTO sign_active (code, batch_id) VALUES (?, ?)')
      for (const entry of entries) {
        const previous = existing.get(entry.code) as
          | {
              numbered_sha256: string
              plain_sha256: string
              revision: number
            }
          | undefined
        const samePng =
          previous?.numbered_sha256 === entry.numberedSha256 &&
          previous.plain_sha256 === entry.plainSha256
        const wasActive = lastActivity.get(entry.code) as { active: number } | undefined
        if (samePng && wasActive?.active === 1) {
          activate.run(entry.code, batch.id)
          continue
        }
        const nextRevision = (previous?.revision ?? 0) + 1
        const updatedAt = this.now()
        save.run(
          entry.code,
          entry.numberedPng,
          entry.plainPng,
          entry.numberedSha256,
          entry.plainSha256,
          entry.zipSha256,
          entry.width,
          entry.height,
          nextRevision,
          updatedAt,
        )
        revision.run(
          entry.code,
          nextRevision,
          entry.numberedPng,
          entry.plainPng,
          entry.numberedSha256,
          entry.plainSha256,
          entry.zipSha256,
          batch.id,
          1,
          updatedAt,
        )
        activate.run(entry.code, batch.id)
      }
      const retired = this.db
        .prepare(
          `SELECT s.* FROM signs s LEFT JOIN sign_active a ON a.code = s.code
                  WHERE a.code IS NULL`,
        )
        .all() as Array<{
        code: string
        revision: number
        numbered_png: Uint8Array
        plain_png: Uint8Array
        numbered_sha256: string
        plain_sha256: string
        zip_sha256: string
      }>
      const bump = this.db.prepare('UPDATE signs SET revision = ?, updated_at = ? WHERE code = ?')
      for (const old of retired) {
        const previous = lastActivity.get(old.code) as { active: number } | undefined
        if (previous?.active === 0) continue
        const updatedAt = this.now()
        bump.run(old.revision + 1, updatedAt, old.code)
        revision.run(
          old.code,
          old.revision + 1,
          old.numbered_png,
          old.plain_png,
          old.numbered_sha256,
          old.plain_sha256,
          old.zip_sha256,
          batch.id,
          0,
          updatedAt,
        )
      }
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  list(
    query = '',
    limit = 100,
  ): Array<{ code: string; width: number; height: number; revision: number }> {
    const rows = this.db
      .prepare(
        "SELECT s.code, s.width, s.height, s.revision FROM signs s JOIN sign_active a ON a.code = s.code WHERE s.code LIKE ? ESCAPE '\\' ORDER BY s.code LIMIT ?",
      )
      .all(`%${query.replace(/[\\%_]/g, '\\$&')}%`, limit) as Array<{
      code: string
      width: number
      height: number
      revision: number
    }>
    return rows.map((row) => ({
      code: row.code,
      width: row.width,
      height: row.height,
      revision: row.revision,
    }))
  }

  /** Размеры именно выбранного PNG; история не подменяется активным каталогом. */
  getMetadata(
    code: string,
    revision: number,
  ): { code: string; revision: number; width: number; height: number } | null {
    const asset = this.getPng(code, false, revision)
    if (!asset) return null
    const png = Buffer.from(asset)
    if (
      png.length < 24 ||
      !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
      png.toString('ascii', 12, 16) !== 'IHDR'
    )
      return null
    const width = png.readUInt32BE(16)
    const height = png.readUInt32BE(20)
    if (!width || !height) return null
    return { code, revision, width, height }
  }

  getPng(code: string, numbered: boolean, revision?: number): Uint8Array | null {
    const column = numbered ? 'numbered_png' : 'plain_png'
    const row = this.db
      .prepare(
        revision === undefined
          ? `SELECT ${column} AS asset FROM signs JOIN sign_active USING (code) WHERE code = ?`
          : `SELECT ${column} AS asset FROM sign_revisions WHERE code = ? AND revision = ? AND active = 1`,
      )
      .get(...(revision === undefined ? [code] : [code, revision])) as
      { asset: Uint8Array } | undefined
    return row?.asset ?? null
  }
}
