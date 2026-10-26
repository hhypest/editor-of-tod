import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import type { Pu66LifecycleWrite } from '../../src/domain/pu66-lifecycle'
import { openDatabase } from '../database/connection'
import { migrateDatabase } from '../database/migration-runner'
import { SqliteTransactionRunner } from '../database/transaction-runner'
import { Pu66KeyResolver } from '../pu66/key-resolver'
import { Pu66Repository } from '../pu66/repository'
import { Pu66LifecycleRepository } from '../pu66/lifecycle-repository'
import { Pu66LifecycleService } from '../pu66/lifecycle-service'
import { applyPu66Lifecycle } from '../pu66-lifecycle'
import { AmbiguousPu66Key, InvalidPu66Lifecycle } from '../pu66/errors'
import { RevisionConflict } from '../storage-errors'
import { readCard, seedReadCard } from './pu66-read-fixture'

const connections: DatabaseSync[] = [],
  directories: string[] = []
const now = () => '2030-02-01T12:00:00.000Z'
const exclude = (keys: string[], successorKey: string | null = null): Pu66LifecycleWrite => ({
  action: 'exclude',
  keys,
  date: '2030-01-30',
  actor: 'Учебный специалист',
  reason: 'reassigned',
  comment: 'Вымышленное исключение',
  successorKey,
})
afterEach(() => {
  for (const db of connections.splice(0)) db.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})
function setup(path = ':memory:') {
  const db = openDatabase(path)
  connections.push(db)
  migrateDatabase(db, { path, now })
  const keys = new Pu66KeyResolver(db),
    cards = new Pu66Repository(db, keys),
    events = new Pu66LifecycleRepository(db, keys, now),
    transactions = new SqliteTransactionRunner(db),
    service = new Pu66LifecycleService(cards, events, transactions, now),
    first = readCard('99999:88:3'),
    second = readCard('99999:89:4'),
    successor = readCard('99999:90:5')
  for (const card of [first, second, successor]) seedReadCard(db, card)
  return { db, keys, cards, events, transactions, service, first, second, successor }
}

describe('PU-66 lifecycle storage and commands without RegistryStore', () => {
  it('preserves aliases/missing state and latest-id status even when a restore is backdated', () => {
    const { db, events, service, first, successor } = setup()
    const alias = db.prepare('INSERT INTO pu66_key_aliases VALUES (?, ?)')
    alias.run('old-single', first.key)
    alias.run('ambiguous', null)
    alias.run('dangling', 'missing-target')
    expect(events.getStatus('missing')).toBeNull()
    expect(events.list('missing')).toBeNull()
    expect(events.getStatus('dangling')).toEqual({
      referenceId: 'missing-target',
      excluded: false,
      event: null,
      successorKey: null,
    })
    expect(events.list(first.key)).toEqual([])
    expect(() => events.getStatus('ambiguous')).toThrow(AmbiguousPu66Key)
    expect(() => service.plan(exclude(['old-single']))).toThrow(InvalidPu66Lifecycle)
    expect(() => service.plan(exclude([first.key], 'old-single'))).toThrow(InvalidPu66Lifecycle)
    const input = exclude([first.key], successor.key)
    service.record(input, service.plan(input).fingerprint)
    expect(events.getStatus('old-single')).toMatchObject({
      referenceId: first.key,
      excluded: true,
      successorKey: successor.key,
    })
    const restore: Pu66LifecycleWrite = {
      action: 'restore',
      keys: [first.key],
      date: '2029-01-01',
      actor: 'Учебный',
      comment: 'Возврат',
    }
    service.record(restore, service.plan(restore).fingerprint)
    db.exec('PRAGMA query_only = ON')
    expect(events.getStatus('old-single')).toMatchObject({
      excluded: false,
      successorKey: null,
      event: { action: 'restore', date: '2029-01-01', reason: null },
    })
    expect(events.list('old-single')?.map((row) => row.action)).toEqual(['restore', 'exclude'])
  })

  it.each(['selected-revision', 'successor-revision', 'successor-event'] as const)(
    'rejects a stale preview after %s changes without adding selected events',
    (change) => {
      const { db, service, events, first, successor } = setup(),
        input = exclude([first.key], successor.key),
        plan = service.plan(input)
      if (change === 'selected-revision') seedReadCard(db, first, 2)
      else if (change === 'successor-revision') seedReadCard(db, successor, 2)
      else {
        const remove = exclude([successor.key])
        service.record(remove, service.plan(remove).fingerprint)
        const restore: Pu66LifecycleWrite = {
          action: 'restore',
          keys: [successor.key],
          date: '2030-01-30',
          actor: 'Учебный',
          comment: '',
        }
        service.record(restore, service.plan(restore).fingerprint)
      }
      expect(() => service.record(input, plan.fingerprint)).toThrow(RevisionConflict)
      expect(events.list(first.key)).toEqual([])
      expect(db.isTransaction).toBe(false)
    },
  )

  it('rechecks the full plan under a write lock and exposes no partial batch to another connection', () => {
    const directory = mkdtempSync(join(tmpdir(), 'tod-lifecycle-lock-'))
    directories.push(directory)
    const path = join(directory, 'registry.sqlite'),
      { db, keys, cards, events, transactions, first, second } = setup(path),
      other = openDatabase(path)
    connections.push(other)
    other.exec('PRAGMA busy_timeout = 1')
    let recording = false,
      checked = false
    const service = new Pu66LifecycleService(
      {
        list(includeExcluded) {
          if (recording) {
            checked = true
            expect(db.isTransaction).toBe(true)
            expect(includeExcluded).toBe(true)
            expect(() =>
              other
                .prepare('UPDATE pu66_cards SET updated_at = ? WHERE key = ?')
                .run('blocked', first.key),
            ).toThrow(/locked/)
            expect(other.prepare('SELECT COUNT(*) AS count FROM pu66_lifecycle').get()).toEqual({
              count: 0,
            })
          }
          return cards.list(includeExcluded)
        },
      },
      events,
      transactions,
      now,
    )
    const input = exclude([second.key, first.key]),
      plan = service.plan(input)
    expect(plan.items.map((item) => item.referenceId)).toEqual([second.key, first.key])
    recording = true
    expect(service.record(input, plan.fingerprint)).toBe(2)
    expect(checked).toBe(true)
    expect(other.prepare('SELECT COUNT(*) AS count FROM pu66_lifecycle').get()).toEqual({
      count: 2,
    })
    const otherEvents = new Pu66LifecycleRepository(other, new Pu66KeyResolver(other), now)
    expect(otherEvents.getStatus(first.key)).toEqual(events.getStatus(first.key))
    expect(keys.resolve(first.key)).toBe(first.key)
  })

  it('rolls back a late batch failure and leaves cards, revisions and the old preview intact', () => {
    const { db, events, service, first, second } = setup(),
      input = exclude([first.key, second.key]),
      plan = service.plan(input),
      cards = db.prepare('SELECT * FROM pu66_cards ORDER BY key').all(),
      revisions = db.prepare('SELECT * FROM pu66_revisions ORDER BY key, revision').all()
    db.exec(
      `CREATE TRIGGER fail_second_lifecycle AFTER INSERT ON pu66_lifecycle WHEN NEW.key = '99999:89:4' BEGIN SELECT RAISE(ABORT, 'late batch failure'); END`,
    )
    expect(() => service.record(input, plan.fingerprint)).toThrow('late batch failure')
    expect(db.isTransaction).toBe(false)
    expect(events.list(first.key)).toEqual([])
    expect(events.list(second.key)).toEqual([])
    expect(service.plan(input)).toEqual(plan)
    db.exec('DROP TRIGGER fail_second_lifecycle')
    service.record(input, plan.fingerprint)
    expect(db.prepare('SELECT * FROM pu66_cards ORDER BY key').all()).toEqual(cards)
    expect(db.prepare('SELECT * FROM pu66_revisions ORDER BY key, revision').all()).toEqual(
      revisions,
    )
    expect(() => service.record(input, plan.fingerprint)).toThrow(RevisionConflict)
    expect(events.list(first.key)).toHaveLength(1)
  })

  it('keeps backup failure and post-backup revision checks through the narrow command port', async () => {
    const { db, events, service, first, successor } = setup(),
      input = exclude([first.key], successor.key),
      expectedFingerprint = service.plan(input).fingerprint
    let failBackup = true,
      recorded = 0,
      backedUp = 0
    const commands = {
      planPu66Lifecycle: (value: Pu66LifecycleWrite) => service.plan(value),
      recordPu66Lifecycle: (value: Pu66LifecycleWrite, fingerprint: string) => {
        recorded++
        return service.record(value, fingerprint)
      },
      async createBackup() {
        backedUp++
        expect(db.isTransaction).toBe(false)
        await Promise.resolve()
        if (failBackup) throw new Error('backup failed')
        seedReadCard(db, successor, 2)
        return 'fictional-backup.sqlite'
      },
    }
    await expect(
      applyPu66Lifecycle(commands, {
        input: { ...input, actor: 'Другой учебный' },
        expectedFingerprint,
      }),
    ).rejects.toThrow(RevisionConflict)
    expect(backedUp).toBe(0)
    await expect(applyPu66Lifecycle(commands, { input, expectedFingerprint })).rejects.toThrow(
      'backup failed',
    )
    expect(recorded).toBe(0)
    failBackup = false
    await expect(applyPu66Lifecycle(commands, { input, expectedFingerprint })).rejects.toThrow(
      RevisionConflict,
    )
    expect(recorded).toBe(1)
    expect(events.list(first.key)).toEqual([])
    expect(db.isTransaction).toBe(false)
  })

  it('validates before reading cards and rolls back if the event clock fails', () => {
    const { db, keys, cards, events, transactions, first } = setup()
    let reads = 0
    const service = new Pu66LifecycleService(
      {
        list(value) {
          reads++
          return cards.list(value)
        },
      },
      new Pu66LifecycleRepository(db, keys, () => {
        throw new Error('event clock failed')
      }),
      transactions,
      now,
    )
    expect(() => service.plan({ ...exclude([first.key]), date: '9999-01-01' })).toThrow(
      InvalidPu66Lifecycle,
    )
    expect(reads).toBe(0)
    expect(() => service.plan(exclude([first.key, first.key]))).toThrow()
    expect(reads).toBe(0)
    const input = exclude([first.key]),
      plan = service.plan(input)
    expect(() => service.record(input, plan.fingerprint)).toThrow('event clock failed')
    expect(db.isTransaction).toBe(false)
    expect(events.list(first.key)).toEqual([])
  })
})
