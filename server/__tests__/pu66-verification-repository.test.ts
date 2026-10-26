import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../database/connection'
import { migrateDatabase } from '../database/migration-runner'
import { Pu66KeyResolver } from '../pu66/key-resolver'
import { Pu66VerificationRepository } from '../pu66/verification-repository'
import { AmbiguousPu66Key, InvalidPu66Lifecycle, InvalidPu66Verification } from '../pu66/errors'
import {
  InvalidPu66Lifecycle as FacadeLifecycleError,
  InvalidPu66Verification as FacadeVerificationError,
} from '../store'
import { RevisionConflict } from '../storage-errors'
import { readCard, seedReadCard } from './pu66-read-fixture'

const connections: DatabaseSync[] = [],
  directories: string[] = []
const input = { expectedRevision: 1, verifiedAt: '2030-01-30', verifiedBy: 'Учебный специалист' }
const now = () => '2030-02-01T12:00:00.000Z'
afterEach(() => {
  for (const db of connections.splice(0)) db.close()
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true })
})
function setup(path = ':memory:') {
  const db = openDatabase(path)
  connections.push(db)
  migrateDatabase(db, { path, now })
  const keys = new Pu66KeyResolver(db)
  return { db, keys, journal: new Pu66VerificationRepository(db, keys, () => null, now) }
}

describe('PU-66 verification storage without RegistryStore', () => {
  it('preserves missing/empty/dangling reads, aliases and shared error constructors', () => {
    const { db, journal } = setup(),
      card = readCard()
    seedReadCard(db, card)
    const alias = db.prepare('INSERT INTO pu66_key_aliases VALUES (?, ?)')
    alias.run('old-single', card.key)
    alias.run('old-ambiguous', null)
    alias.run('dangling', 'missing-target')
    expect(FacadeLifecycleError).toBe(InvalidPu66Lifecycle)
    expect(FacadeVerificationError).toBe(InvalidPu66Verification)
    expect(journal.list('missing')).toBeNull()
    expect(journal.list(card.key)).toEqual([])
    expect(journal.list('dangling')).toEqual([])
    expect(journal.record('dangling', input)).toBeNull()
    expect(db.isTransaction).toBe(false)
    expect(() => journal.record('old-ambiguous', input)).toThrow(AmbiguousPu66Key)
    expect(() => journal.list('old-ambiguous')).toThrow(AmbiguousPu66Key)
    expect(journal.record('old-single', input)).toEqual({
      cardRevision: 1,
      verifiedAt: input.verifiedAt,
      verifiedBy: input.verifiedBy,
      recordedAt: now(),
    })
    expect(journal.list('old-single')).toEqual(journal.list(card.key))
    expect(db.prepare('SELECT key FROM pu66_verifications').all()).toEqual([{ key: card.key }])
  })

  it('keeps validation, missing key, clock and future-date checks before BEGIN', () => {
    const { db, keys } = setup(),
      card = readCard(),
      calls: string[] = []
    seedReadCard(db, card)
    const journal = new Pu66VerificationRepository(
      db,
      {
        resolve(key) {
          calls.push('resolve')
          return keys.resolve(key)
        },
      },
      () => {
        calls.push('status')
        return null
      },
      () => {
        expect(db.isTransaction).toBe(false)
        calls.push('clock')
        return now()
      },
    )
    expect(() => journal.record('missing', { ...input, verifiedBy: ' ' })).toThrow()
    expect(calls).toEqual([])
    expect(journal.record('missing', { ...input, verifiedAt: '9999-01-01' })).toBeNull()
    expect(calls.splice(0)).toEqual(['resolve'])
    expect(() =>
      journal.record(card.key, { ...input, expectedRevision: 2, verifiedAt: '9999-01-01' }),
    ).toThrow(InvalidPu66Verification)
    expect(calls).toEqual(['resolve', 'clock'])
    expect(db.isTransaction).toBe(false)
    expect(journal.list(card.key)).toEqual([])
  })

  it('guards revision before lifecycle and checks lifecycle under the write lock', () => {
    const directory = mkdtempSync(join(tmpdir(), 'tod-verification-lock-'))
    directories.push(directory)
    const path = join(directory, 'registry.sqlite'),
      { db, keys } = setup(path),
      card = readCard()
    seedReadCard(db, card)
    const other = openDatabase(path)
    connections.push(other)
    other.exec('PRAGMA busy_timeout = 1')
    let calls = 0,
      excluded = true
    const journal = new Pu66VerificationRepository(
      db,
      keys,
      (key) => {
        calls++
        expect(key).toBe(card.key)
        expect(db.isTransaction).toBe(true)
        expect(() =>
          other.prepare('UPDATE pu66_cards SET updated_at = ? WHERE key = ?').run('blocked', key),
        ).toThrow(/locked/)
        expect(other.prepare('SELECT COUNT(*) AS count FROM pu66_verifications').get()).toEqual({
          count: 0,
        })
        return { excluded }
      },
      now,
    )
    expect(() => journal.record(card.key, { ...input, expectedRevision: 2 })).toThrow(
      RevisionConflict,
    )
    expect(calls).toBe(0)
    expect(() => journal.record(card.key, input)).toThrow(
      'Карточка исключена: верните её в действующие перед сверкой.',
    )
    expect(db.isTransaction).toBe(false)
    excluded = false
    expect(journal.record(card.key, input)?.cardRevision).toBe(1)
    expect(calls).toBe(2)
    expect(other.prepare('SELECT COUNT(*) AS count FROM pu66_verifications').get()).toEqual({
      count: 1,
    })
    expect(db.isTransaction).toBe(false)
  })

  it('appends identical and backdated records by insertion order across revisions and reopen', () => {
    const directory = mkdtempSync(join(tmpdir(), 'tod-verification-history-'))
    directories.push(directory)
    const path = join(directory, 'registry.sqlite'),
      { db, journal } = setup(path),
      card = readCard()
    seedReadCard(db, card)
    journal.record(card.key, input)
    journal.record(card.key, input)
    seedReadCard(db, { ...card, roadName: 'Другая вымышленная дорога' }, 2)
    const current = db.prepare('SELECT * FROM pu66_cards').all(),
      revisions = db.prepare('SELECT * FROM pu66_revisions ORDER BY revision').all()
    expect(() => journal.record(card.key, input)).toThrow(RevisionConflict)
    journal.record(card.key, {
      ...input,
      expectedRevision: 2,
      verifiedAt: '2030-01-01',
      verifiedBy: '  Учебный Б  ',
    })
    const history = journal.list(card.key)!
    expect(history.map((row) => [row.cardRevision, row.verifiedAt, row.verifiedBy])).toEqual([
      [2, '2030-01-01', 'Учебный Б'],
      [1, '2030-01-30', input.verifiedBy],
      [1, '2030-01-30', input.verifiedBy],
    ])
    expect(db.prepare('SELECT * FROM pu66_cards').all()).toEqual(current)
    expect(db.prepare('SELECT * FROM pu66_revisions ORDER BY revision').all()).toEqual(revisions)
    connections.splice(connections.indexOf(db), 1)
    db.close()
    const reopened = setup(path)
    reopened.db.exec('PRAGMA query_only = ON')
    expect(reopened.journal.list(card.key)).toEqual(history)
  })

  it('rolls back status/insert failures and preserves the caller connection for the next command', () => {
    const { db, keys } = setup(),
      card = readCard()
    seedReadCard(db, card)
    let failStatus = true
    const journal = new Pu66VerificationRepository(
      db,
      keys,
      () => {
        if (failStatus) throw new Error('status read failed')
        return null
      },
      now,
    )
    expect(() => journal.record(card.key, input)).toThrow('status read failed')
    expect(db.isTransaction).toBe(false)
    failStatus = false
    db.exec(
      `CREATE TRIGGER fail_verification AFTER INSERT ON pu66_verifications BEGIN SELECT RAISE(ABORT, 'late insert failed'); END`,
    )
    expect(() => journal.record(card.key, input)).toThrow('late insert failed')
    expect(db.isTransaction).toBe(false)
    expect(journal.list(card.key)).toEqual([])
    db.exec('DROP TRIGGER fail_verification')
    journal.record(card.key, input)
    expect(journal.list(card.key)).toHaveLength(1)
    expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 13 })
  })
})
