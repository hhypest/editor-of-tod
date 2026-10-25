import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { importSchemeJson } from '../../src/domain/import'
import { RegistryStore } from '../store'

const scheme = importSchemeJson(readFileSync('tests/fixtures/manual-v1.json', 'utf8')).scheme

/** Run against the original facade before extracting ProjectRepository. */
describe('project repository contracts through RegistryStore', () => {
  it('keeps the injected clock receiver, does not read it for no-op, and forces a new revision on restore', () => {
    let calls = 0
    function clock(this: RegistryStore) {
      expect(this).toBeInstanceOf(RegistryStore)
      expect(this.path).toBe(':memory:')
      calls++
      return `2030-01-01T00:00:${String(calls).padStart(2, '0')}.000Z`
    }
    const store = new RegistryStore(':memory:', clock)
    try {
      const before = calls // Initial normative entries have their own clock reads.
      const first = store.saveProject(scheme, 0)
      expect(calls).toBe(before + 1)
      expect(store.saveProject(scheme, 1)).toEqual(first)
      expect(calls).toBe(before + 1)
      expect(store.restoreProject(scheme.id, 1, 1)).toMatchObject({ scheme, revision: 2 })
      expect(calls).toBe(before + 2)
    } finally {
      store.close()
    }
  })

  it('rolls back a changed draft and newly deduplicated source when the next history write fails', () => {
    const directory = mkdtempSync(join(tmpdir(), 'tod-project-history-failure-'))
    const path = join(directory, 'registry.sqlite')
    const store = new RegistryStore(path)
    const raw = new DatabaseSync(path)
    try {
      const first = { ...store.saveProject(scheme, 0), storedSchemaVersion: 10 }
      const edited = {
        ...scheme,
        parameters: { ...scheme.parameters, locationText: 'Вымышленная правка' },
        source: { ...scheme.source, originalJson: '{"fictional":"new source"}' },
      }
      raw.exec(`CREATE TRIGGER reject_second_revision BEFORE INSERT ON project_revisions
        WHEN NEW.revision = 2 BEGIN SELECT RAISE(ABORT, 'synthetic history failure'); END`)
      expect(() => store.saveProject(edited, 1)).toThrow('synthetic history failure')
      expect(store.getProject(scheme.id)).toEqual(first)
      expect(store.getProjectRevision(scheme.id, 1)).toEqual(first)
      expect(store.listProjects()).toMatchObject([
        { locationText: scheme.parameters.locationText, revision: 1 },
      ])
      expect(store.listProjectRevisions(scheme.id)).toHaveLength(1)
      expect(raw.prepare('SELECT COUNT(*) AS count FROM project_sources').get()).toEqual({
        count: 1,
      })
      raw.exec('DROP TRIGGER reject_second_revision')
      expect(store.saveProject(edited, 1)).toMatchObject({ scheme: edited, revision: 2 })
      expect(store.getProjectRevision(scheme.id, 1)).toEqual(first)
    } finally {
      raw.close()
      store.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
