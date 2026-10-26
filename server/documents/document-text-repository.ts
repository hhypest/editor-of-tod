import type { DatabaseSync } from 'node:sqlite'

export class DocumentTextRepository {
  private readonly db: DatabaseSync

  constructor(db: DatabaseSync) {
    this.db = db
  }

  /** Сохранённый текст страниц документа или null, если текст ещё не извлекался. */
  get(id: number): string[] | null {
    const rows = this.db
      .prepare('SELECT page, text FROM document_pages WHERE document_id = ? ORDER BY page')
      .all(id) as Array<{ page: number; text: string }>
    return rows.length ? rows.map((row) => row.text) : null
  }

  save(id: number, pages: readonly string[]): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare('DELETE FROM document_pages WHERE document_id = ?').run(id)
      const insert = this.db.prepare(
        'INSERT INTO document_pages (document_id, page, text) VALUES (?, ?, ?)',
      )
      // Пустой документ (скан без текста) сохраняется одной пустой страницей, чтобы не
      // разбирать его повторно.
      ;(pages.length ? pages : ['']).forEach((text, index) => insert.run(id, index + 1, text))
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  /** Caller owns the transaction spanning text and PDF deletion. */
  delete(id: number): void {
    this.db.prepare('DELETE FROM document_pages WHERE document_id = ?').run(id)
  }
}
