import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import {
  RegistryStore,
  RevisionConflict,
  InvalidPu66Verification,
  InvalidPu66Lifecycle,
} from '../store'
import { readCard, readEntry } from './pu66-read-fixture'

/** Characterize the original facade before extracting verification storage. */
describe('PU-66 verification facade contracts', () => {
  it('preserves clock receiver, date/error precedence and insertion-order history', () => {
    const receivers: unknown[] = []
    const directory = mkdtempSync(join(tmpdir(), 'tod-verification-contract-')),
      path = join(directory, 'registry.sqlite'),
      store = new RegistryStore(path, function (this: unknown) {
        receivers.push(this)
        return '2030-02-01T12:00:00.000Z'
      }),
      raw = new DatabaseSync(path),
      card = readCard()
    const input = { expectedRevision: 1, verifiedAt: '2030-01-30', verifiedBy: '  Учебный А  ' }
    try {
      store.importPu66([readEntry(card)])
      expect(store.recordPu66Verification(card.key, input)).toEqual({
        cardRevision: 1,
        verifiedAt: '2030-01-30',
        verifiedBy: 'Учебный А',
        recordedAt: '2030-02-01T12:00:00.000Z',
      })
      expect(receivers.at(-1)).toBe(store)
      store.recordPu66Verification(card.key, {
        ...input,
        verifiedAt: '2030-01-20',
        verifiedBy: 'Учебный Б',
      })
      expect(store.listPu66Verifications(card.key)?.map((row) => row.verifiedBy)).toEqual([
        'Учебный Б',
        'Учебный А',
      ])
      raw
        .prepare(
          `INSERT INTO pu66_lifecycle (key, card_revision, action, date, actor, reason, comment, recorded_at) VALUES (?, 1, 'exclude', '2030-02-01', 'Учебный', 'reassigned', '', '2030-02-01T12:00:00.000Z')`,
        )
        .run(card.key)
      expect(() =>
        store.recordPu66Verification(card.key, {
          ...input,
          expectedRevision: 2,
          verifiedAt: '9999-01-01',
        }),
      ).toThrow(InvalidPu66Verification)
      expect(() =>
        store.recordPu66Verification(card.key, { ...input, expectedRevision: 2 }),
      ).toThrow(RevisionConflict)
      expect(() => store.recordPu66Verification(card.key, input)).toThrow(InvalidPu66Lifecycle)
      expect(
        store.recordPu66Verification('missing', { ...input, verifiedAt: '9999-01-01' }),
      ).toBeNull()
      expect(store.listPu66Verifications(card.key)).toHaveLength(2)
    } finally {
      raw.close()
      store.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('rolls back a late insert failure and leaves the next write usable without changing the card', () => {
    const directory = mkdtempSync(join(tmpdir(), 'tod-verification-rollback-')),
      path = join(directory, 'registry.sqlite'),
      store = new RegistryStore(path, () => '2030-02-01T12:00:00.000Z'),
      raw = new DatabaseSync(path),
      card = readCard(),
      input = { expectedRevision: 1, verifiedAt: '2030-01-30', verifiedBy: 'Учебный' }
    try {
      store.importPu66([readEntry(card)])
      const before = raw.prepare('SELECT * FROM pu66_cards').all()
      raw.exec(
        `CREATE TRIGGER fail_verification AFTER INSERT ON pu66_verifications BEGIN SELECT RAISE(ABORT, 'verification insert failed'); END`,
      )
      expect(() => store.recordPu66Verification(card.key, input)).toThrow(
        'verification insert failed',
      )
      expect(store.listPu66Verifications(card.key)).toEqual([])
      raw.exec('DROP TRIGGER fail_verification')
      expect(store.recordPu66Verification(card.key, input)?.cardRevision).toBe(1)
      expect(raw.prepare('SELECT * FROM pu66_cards').all()).toEqual(before)
      expect(raw.prepare('SELECT COUNT(*) AS count FROM pu66_revisions').get()).toEqual({
        count: 1,
      })
    } finally {
      raw.close()
      store.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
