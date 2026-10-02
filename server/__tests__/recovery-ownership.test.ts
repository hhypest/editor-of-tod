import { randomUUID } from 'node:crypto'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { importSchemeJson } from '../../src/domain/import'
import { RECOVERY_LEASE_MS } from '../../src/application/recovery-session'
import { RegistryStore, RecoveryOwned, RevisionConflict } from '../store'

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
  it('protects live copies, renews without changing their content and fences the old window after takeover', () => {
    let now = Date.parse('2026-10-02T12:00:00Z')
    const store = new RegistryStore(':memory:', () => new Date(now).toISOString())
    const first = randomUUID(),
      second = randomUUID()
    const draft = input()
    try {
      const saved = store.saveRecovery(draft, first)
      expect(store.listRecoveries()).toMatchObject([{ active: true }])
      expect(() => store.assertRecoveryAvailable(draft.sessionId)).toThrow(RecoveryOwned)
      expect(() => store.claimRecovery(draft.sessionId, second, 1)).toThrow(RecoveryOwned)
      expect(() => store.deleteRecovery(draft.sessionId, 1, second)).toThrow(RecoveryOwned)
      expect(() => store.saveRecovery({ ...draft, expectedVersion: 1 }, second)).toThrow(
        RecoveryOwned,
      )
      now += RECOVERY_LEASE_MS - 1
      store.heartbeatRecovery(draft.sessionId, first)
      now += 2
      expect(store.listRecoveries()[0]?.active).toBe(true)
      expect(store.getRecovery(draft.sessionId)).toEqual(saved)
      now += RECOVERY_LEASE_MS
      expect(store.listRecoveries()[0]?.active).toBe(false)
      expect(() => store.claimRecovery(draft.sessionId, second, 2)).toThrow(RevisionConflict)
      const claimed = store.claimRecovery(draft.sessionId, second, 1)
      expect(claimed.version).toBe(2)
      expect(claimed.scheme).toEqual(scheme)
      expect(() => store.heartbeatRecovery(draft.sessionId, first)).toThrow(RecoveryOwned)
      store.releaseRecovery(draft.sessionId, first)
      expect(store.listRecoveries()[0]?.active).toBe(true)
      expect(() => store.saveRecovery({ ...draft, expectedVersion: 1 }, first)).toThrow(
        RecoveryOwned,
      )
      store.releaseRecovery(draft.sessionId, second)
      expect(() => store.deleteRecovery(draft.sessionId, 1, first)).toThrow(RevisionConflict)
      store.deleteRecovery(draft.sessionId, 2, first)
      expect(store.listRecoveries()).toEqual([])
    } finally {
      store.close()
    }
  })

  it('serializes competing claims from two SQLite connections and rejects stale writes after release', () => {
    const directory = mkdtempSync(join(tmpdir(), 'tod-owner-'))
    const path = join(directory, 'registry.sqlite')
    const one = new RegistryStore(path),
      two = new RegistryStore(path)
    const first = randomUUID(),
      second = randomUUID(),
      third = randomUUID()
    const draft = input()
    try {
      one.saveRecovery(draft, first)
      one.releaseRecovery(draft.sessionId, first)
      expect(two.claimRecovery(draft.sessionId, second, 1).version).toBe(2)
      expect(() => one.claimRecovery(draft.sessionId, third, 1)).toThrow(RecoveryOwned)
      expect(() => one.saveRecovery({ ...draft, expectedVersion: 1 }, first)).toThrow(RecoveryOwned)
      two.heartbeatRecovery(draft.sessionId, second)
      expect(one.getRecovery(draft.sessionId)?.version).toBe(2)
    } finally {
      one.close()
      two.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('migrates v12 copies without losing pending input or creating saved revisions', () => {
    const directory = mkdtempSync(join(tmpdir(), 'tod-owner-migration-'))
    const path = join(directory, 'registry.sqlite')
    const old = new RegistryStore(path)
    const draft = input()
    old.saveRecovery(draft, randomUUID())
    old.close()
    const raw = new DatabaseSync(path)
    raw.exec(
      'ALTER TABLE project_recovery DROP COLUMN owner_id; ALTER TABLE project_recovery DROP COLUMN owner_until; PRAGMA user_version = 12;',
    )
    raw.close()
    const migrated = new RegistryStore(path)
    try {
      expect(migrated.schemaVersion()).toBe(13)
      expect(migrated.listRecoveries()).toMatchObject([{ active: false, version: 1 }])
      expect(migrated.claimRecovery(draft.sessionId, randomUUID(), 1).scheme).toEqual(scheme)
      expect(migrated.listProjects()).toEqual([])
    } finally {
      migrated.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
