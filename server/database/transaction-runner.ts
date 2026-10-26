import type { DatabaseSync } from 'node:sqlite'
import type { TransactionRunner } from '../transaction-runner.ts'

export class SqliteTransactionRunner implements TransactionRunner {
  private readonly db: DatabaseSync

  constructor(db: DatabaseSync) {
    this.db = db
  }

  immediate<T>(operation: () => T): T {
    // A failed BEGIN must not roll back a transaction owned by the caller.
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = operation()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }
}
