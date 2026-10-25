import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { importSchemeJson } from '../../src/domain/import'
import { RegistryStore } from '../store'

const scheme = importSchemeJson(readFileSync('tests/fixtures/manual-v1.json', 'utf8')).scheme

/** These failure contracts also run on the facade before the source-store extraction. */
describe('project source transactions through RegistryStore', () => {
  it('rolls back the source and draft if writing the immutable revision fails', () => {
    const directory = mkdtempSync(join(tmpdir(), 'tod-source-revision-failure-'))
    const path = join(directory, 'registry.sqlite')
    const store = new RegistryStore(path)
    const raw = new DatabaseSync(path)
    try {
      raw.exec(`CREATE TRIGGER reject_revision BEFORE INSERT ON project_revisions
        BEGIN SELECT RAISE(ABORT, 'synthetic revision failure'); END`)
      expect(() => store.saveProject(scheme, 0)).toThrow('synthetic revision failure')
      expect(store.getProject(scheme.id)).toBeNull()
      expect(store.listProjectRevisions(scheme.id)).toEqual([])
      expect(raw.prepare('SELECT COUNT(*) AS count FROM project_sources').get()).toEqual({
        count: 0,
      })
      raw.exec('DROP TRIGGER reject_revision')
      expect(store.saveProject(scheme, 0)).toMatchObject({ revision: 1, scheme })
    } finally {
      raw.close()
      store.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('restores the recovery and its source if last-reference cleanup fails', () => {
    const directory = mkdtempSync(join(tmpdir(), 'tod-source-cleanup-failure-'))
    const path = join(directory, 'registry.sqlite')
    const store = new RegistryStore(path)
    const raw = new DatabaseSync(path)
    const ownerId = randomUUID()
    const input = {
      sessionId: randomUUID(),
      scheme,
      expectedVersion: 0,
      baseRevision: null,
      detailsDraft: null,
      placementDraft: null,
      fileName: 'fictional.json',
    }
    try {
      const saved = store.saveRecovery(input, ownerId)
      raw.exec(`CREATE TRIGGER reject_cleanup AFTER DELETE ON project_sources
        BEGIN SELECT RAISE(ABORT, 'synthetic cleanup failure'); END`)
      expect(() => store.deleteRecovery(input.sessionId, 1, ownerId)).toThrow(
        'synthetic cleanup failure',
      )
      expect(store.getRecovery(input.sessionId, { ownerId })).toEqual(saved)
      expect(raw.prepare('SELECT COUNT(*) AS count FROM project_sources').get()).toEqual({
        count: 1,
      })
      raw.exec('DROP TRIGGER reject_cleanup')
      store.deleteRecovery(input.sessionId, 1, ownerId)
      expect(store.getRecovery(input.sessionId)).toBeNull()
      expect(raw.prepare('SELECT COUNT(*) AS count FROM project_sources').get()).toEqual({
        count: 0,
      })
    } finally {
      raw.close()
      store.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
