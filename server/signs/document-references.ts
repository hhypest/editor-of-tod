import type { DatabaseSync } from 'node:sqlite'

/** Includes every historical catalog batch, not only the latest/active source. */
export class SignCatalogDocumentReferences {
  private readonly db: DatabaseSync

  constructor(db: DatabaseSync) {
    this.db = db
  }

  countBatches(id: number): number {
    const batches = this.db
      .prepare('SELECT COUNT(*) AS count FROM sign_catalog_batches WHERE document_id = ?')
      .get(id) as { count: number }
    return batches.count
  }
}
