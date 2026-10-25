import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { importSchemeJson } from '../../src/domain/import'
import { createSchemeDetailsDraft } from '../../src/domain/edit-details'
import { RECOVERY_LEASE_MS } from '../../src/application/recovery-session'
import { RegistryStore } from '../store'

const scheme = importSchemeJson(readFileSync('tests/fixtures/manual-v1.json', 'utf8')).scheme
const input = () => ({
  sessionId: randomUUID(),
  scheme,
  expectedVersion: 0,
  baseRevision: null,
  detailsDraft: createSchemeDetailsDraft(scheme),
  placementDraft: null,
  fileName: 'fictional.json',
})

/** These contracts run on the unchanged facade before the recovery extraction. */
describe('recovery contracts through RegistryStore', () => {
  it('keeps the injected clock receiver through save/list/claim/renew and preserves pending input', () => {
    let now = Date.parse('2030-01-01T00:00:00.000Z')
    function clock(this: RegistryStore) {
      expect(this).toBeInstanceOf(RegistryStore)
      expect(this.path).toBe(':memory:')
      return new Date(now).toISOString()
    }
    const store = new RegistryStore(':memory:', clock)
    const first = randomUUID(),
      second = randomUUID(),
      draft = input()
    draft.detailsDraft.parameters.locationText = 'Неприменённый учебный ввод'
    try {
      const saved = store.saveRecovery(draft, first)
      expect(store.listRecoveries()).toMatchObject([{ active: true }])
      now += RECOVERY_LEASE_MS
      expect(store.listRecoveries()).toMatchObject([{ active: false }])
      expect(store.claimRecovery(draft.sessionId, second, 1)).toEqual({ ...saved, version: 2 })
      store.heartbeatRecovery(draft.sessionId, second)
      expect(store.getRecovery(draft.sessionId, { ownerId: second })).toEqual({
        ...saved,
        version: 2,
      })
      store.releaseRecovery(draft.sessionId, second)
      store.deleteRecovery(draft.sessionId, 2, second)
      expect(store.listRecoveries()).toEqual([])
    } finally {
      store.close()
    }
  })

  it('rolls back source, owner lease, version and pending fields if updating recovery fails', () => {
    const directory = mkdtempSync(join(tmpdir(), 'tod-recovery-write-failure-'))
    const path = join(directory, 'registry.sqlite')
    let now = '2030-01-01T00:00:00.000Z'
    const store = new RegistryStore(path, () => now)
    const raw = new DatabaseSync(path)
    const owner = randomUUID(),
      draft = input()
    try {
      const saved = store.saveRecovery(draft, owner)
      const before = raw.prepare('SELECT * FROM project_recovery').all()
      raw.exec(`CREATE TRIGGER reject_recovery BEFORE UPDATE ON project_recovery
        BEGIN SELECT RAISE(ABORT, 'synthetic recovery failure'); END`)
      now = '2030-01-01T00:01:00.000Z'
      const changed = {
        ...draft,
        expectedVersion: 1,
        fileName: 'changed.json',
        scheme: {
          ...scheme,
          source: { ...scheme.source, originalJson: '{"fictional":"changed"}' },
        },
      }
      expect(() => store.saveRecovery(changed, owner)).toThrow('synthetic recovery failure')
      expect(raw.prepare('SELECT * FROM project_recovery').all()).toEqual(before)
      expect(raw.prepare('SELECT COUNT(*) AS count FROM project_sources').get()).toEqual({
        count: 1,
      })
      expect(store.getRecovery(draft.sessionId, { ownerId: owner })).toEqual(saved)
      expect(store.listProjects()).toEqual([])
      raw.exec('DROP TRIGGER reject_recovery')
      expect(store.saveRecovery(changed, owner)).toMatchObject({
        version: 2,
        fileName: 'changed.json',
      })
    } finally {
      raw.close()
      store.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
