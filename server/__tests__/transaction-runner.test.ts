import { describe, expect, it } from 'vitest'
import { openDatabase } from '../database/connection'
import { SqliteTransactionRunner } from '../database/transaction-runner'

describe('synchronous SQLite transaction runner', () => {
  it('commits the return value and rolls back failures without closing the connection', () => {
    const db = openDatabase(':memory:'),
      transactions = new SqliteTransactionRunner(db)
    try {
      db.exec('CREATE TABLE fictional (value TEXT)')
      expect(
        transactions.immediate(() => {
          expect(db.isTransaction).toBe(true)
          db.prepare('INSERT INTO fictional VALUES (?)').run('kept')
          return 0
        }),
      ).toBe(0)
      const failure = new Error('command failed')
      expect(() =>
        transactions.immediate(() => {
          db.prepare('INSERT INTO fictional VALUES (?)').run('rolled back')
          throw failure
        }),
      ).toThrow(failure)
      expect(db.isTransaction).toBe(false)
      expect(db.prepare('SELECT value FROM fictional').all()).toEqual([{ value: 'kept' }])
    } finally {
      db.close()
    }
  })

  it('rejects nesting before the callback and preserves a caller-owned transaction', () => {
    const db = openDatabase(':memory:'),
      transactions = new SqliteTransactionRunner(db)
    try {
      db.exec(
        "CREATE TABLE fictional (value TEXT); BEGIN IMMEDIATE; INSERT INTO fictional VALUES ('outer')",
      )
      let called = false
      expect(() =>
        transactions.immediate(() => {
          called = true
        }),
      ).toThrow(/transaction/)
      expect(called).toBe(false)
      expect(db.isTransaction).toBe(true)
      db.exec('COMMIT')
      expect(db.prepare('SELECT value FROM fictional').all()).toEqual([{ value: 'outer' }])
    } finally {
      db.close()
    }
  })
})
