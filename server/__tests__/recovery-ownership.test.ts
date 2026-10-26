import { openTestApplication } from './test-application'
import { randomUUID } from 'node:crypto'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { importSchemeJson } from '../../src/domain/import'
import { RECOVERY_LEASE_MS } from '../../src/application/recovery-session'
import { RecoveryOwned, RevisionConflict } from '../storage-errors'

const scheme = importSchemeJson(readFileSync('tests/fixtures/manual-v1.json', 'utf8')).scheme
const input = () => ({
  sessionId: randomUUID(),
  scheme,
  expectedVersion: 0,
  baseRevision: null,
  detailsDraft: null,
  placementDraft: null,
  fileName: 'fictional.json',
})

describe('recovery ownership', () => {
  it.each(['renew-first', 'claim-first', 'claim-before-save'])(
    'fences wake/claim/save after a suspended lease: %s',
    (order) => {
      let now = Date.parse('2026-10-25T06:00:00Z')
      const directory = mkdtempSync(join(tmpdir(), 'tod-wake-'))
      const path = join(directory, 'registry.sqlite')
      const clock = () => new Date(now).toISOString()
      const one = openTestApplication(path, clock)
      const two = openTestApplication(path, clock)
      const first = randomUUID(),
        second = randomUUID()
      const draft = input()
      const changed = {
        ...draft,
        expectedVersion: 1,
        scheme: {
          ...scheme,
          parameters: { ...scheme.parameters, locationText: 'Правки после сна' },
        },
      }
      try {
        one.recovery.save({ input: draft, ownerId: first })
        now += RECOVERY_LEASE_MS + 60_000
        if (order !== 'claim-first')
          one.recovery.renew({ sessionId: draft.sessionId, ownerId: first })
        if (order === 'renew-first') {
          expect(() =>
            two.recovery.claim({ sessionId: draft.sessionId, ownerId: second, expectedVersion: 1 }),
          ).toThrow(RecoveryOwned)
          expect(one.recovery.save({ input: changed, ownerId: first }).version).toBe(2)
          expect(two.recovery.get(draft.sessionId)?.scheme).toEqual(changed.scheme)
        } else {
          // Another suspension can expire the renewal before the following PUT reaches SQLite.
          if (order === 'claim-before-save') now += RECOVERY_LEASE_MS + 1
          expect(
            two.recovery.claim({ sessionId: draft.sessionId, ownerId: second, expectedVersion: 1 })
              .version,
          ).toBe(2)
          const claimed = two.recovery.get(draft.sessionId)
          expect(() => one.recovery.renew({ sessionId: draft.sessionId, ownerId: first })).toThrow(
            RecoveryOwned,
          )
          expect(() => one.recovery.save({ input: changed, ownerId: first })).toThrow(RecoveryOwned)
          one.recovery.release({ sessionId: draft.sessionId, ownerId: first })
          expect(one.recovery.get(draft.sessionId)).toEqual(claimed)
          // Even after the new owner releases, the stale window must not reclaim by saving.
          two.recovery.release({ sessionId: draft.sessionId, ownerId: second })
          expect(() => one.recovery.save({ input: changed, ownerId: first })).toThrow(RecoveryOwned)
          expect(one.recovery.get(draft.sessionId)).toEqual(claimed)
        }
      } finally {
        one.runtime.close()
        two.runtime.close()
        rmSync(directory, { recursive: true, force: true })
      }
    },
  )

  it('protects live copies, renews without changing their content and fences the old window after takeover', () => {
    let now = Date.parse('2026-10-02T12:00:00Z')
    const store = openTestApplication(':memory:', () => new Date(now).toISOString())
    const first = randomUUID(),
      second = randomUUID()
    const draft = input()
    try {
      const saved = store.recovery.save({ input: draft, ownerId: first })
      expect(store.recovery.list()).toMatchObject([{ active: true }])
      expect(() => store.recovery.assertAvailable(draft.sessionId)).toThrow(RecoveryOwned)
      expect(() =>
        store.recovery.claim({ sessionId: draft.sessionId, ownerId: second, expectedVersion: 1 }),
      ).toThrow(RecoveryOwned)
      expect(() =>
        store.recovery.delete({ sessionId: draft.sessionId, expectedVersion: 1, ownerId: second }),
      ).toThrow(RecoveryOwned)
      expect(() =>
        store.recovery.save({ input: { ...draft, expectedVersion: 1 }, ownerId: second }),
      ).toThrow(RecoveryOwned)
      now += RECOVERY_LEASE_MS - 1
      store.recovery.renew({ sessionId: draft.sessionId, ownerId: first })
      now += 2
      expect(store.recovery.list()[0]?.active).toBe(true)
      expect(store.recovery.get(draft.sessionId)).toEqual(saved)
      now += RECOVERY_LEASE_MS
      expect(store.recovery.list()[0]?.active).toBe(false)
      expect(() =>
        store.recovery.claim({ sessionId: draft.sessionId, ownerId: second, expectedVersion: 2 }),
      ).toThrow(RevisionConflict)
      const claimed = store.recovery.claim({
        sessionId: draft.sessionId,
        ownerId: second,
        expectedVersion: 1,
      })
      expect(claimed.version).toBe(2)
      expect(claimed.scheme).toEqual(scheme)
      expect(() => store.recovery.renew({ sessionId: draft.sessionId, ownerId: first })).toThrow(
        RecoveryOwned,
      )
      store.recovery.release({ sessionId: draft.sessionId, ownerId: first })
      expect(store.recovery.list()[0]?.active).toBe(true)
      expect(() =>
        store.recovery.save({ input: { ...draft, expectedVersion: 1 }, ownerId: first }),
      ).toThrow(RecoveryOwned)
      store.recovery.release({ sessionId: draft.sessionId, ownerId: second })
      expect(() =>
        store.recovery.delete({ sessionId: draft.sessionId, expectedVersion: 1, ownerId: first }),
      ).toThrow(RevisionConflict)
      store.recovery.delete({ sessionId: draft.sessionId, expectedVersion: 2, ownerId: first })
      expect(store.recovery.list()).toEqual([])
    } finally {
      store.runtime.close()
    }
  })

  it('serializes competing claims from two SQLite connections and rejects stale writes after release', () => {
    const directory = mkdtempSync(join(tmpdir(), 'tod-owner-'))
    const path = join(directory, 'registry.sqlite')
    const one = openTestApplication(path),
      two = openTestApplication(path)
    const first = randomUUID(),
      second = randomUUID(),
      third = randomUUID()
    const draft = input()
    try {
      one.recovery.save({ input: draft, ownerId: first })
      one.recovery.release({ sessionId: draft.sessionId, ownerId: first })
      expect(
        two.recovery.claim({ sessionId: draft.sessionId, ownerId: second, expectedVersion: 1 })
          .version,
      ).toBe(2)
      expect(() =>
        one.recovery.claim({ sessionId: draft.sessionId, ownerId: third, expectedVersion: 1 }),
      ).toThrow(RecoveryOwned)
      expect(() =>
        one.recovery.save({ input: { ...draft, expectedVersion: 1 }, ownerId: first }),
      ).toThrow(RecoveryOwned)
      two.recovery.renew({ sessionId: draft.sessionId, ownerId: second })
      expect(one.recovery.get(draft.sessionId)?.version).toBe(2)
    } finally {
      one.runtime.close()
      two.runtime.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('migrates v12 copies without losing pending input or creating saved revisions', () => {
    const directory = mkdtempSync(join(tmpdir(), 'tod-owner-migration-'))
    const path = join(directory, 'registry.sqlite')
    const old = openTestApplication(path)
    const draft = input()
    old.recovery.save({ input: draft, ownerId: randomUUID() })
    old.runtime.close()
    const raw = new DatabaseSync(path)
    raw.exec(
      'ALTER TABLE project_recovery DROP COLUMN owner_id; ALTER TABLE project_recovery DROP COLUMN owner_until; PRAGMA user_version = 12;',
    )
    raw.close()
    const migrated = openTestApplication(path)
    try {
      expect(migrated.runtime.schemaVersion()).toBe(13)
      expect(migrated.recovery.list()).toMatchObject([{ active: false, version: 1 }])
      expect(
        migrated.recovery.claim({
          sessionId: draft.sessionId,
          ownerId: randomUUID(),
          expectedVersion: 1,
        }).scheme,
      ).toEqual(scheme)
      expect(migrated.projects.list()).toEqual([])
    } finally {
      migrated.runtime.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
