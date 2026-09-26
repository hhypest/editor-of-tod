import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { importSchemeJson } from '../../src/domain/import'
import { normativeDraftSchema, type CrossingDraft } from '../../src/domain/registry'
import { RegistryStore, RevisionConflict } from '../store'

const directories: string[] = []
const fixture = readFileSync(
  new URL('../../tests/fixtures/manual-v1.json', import.meta.url),
  'utf8',
)
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

const crossing: CrossingDraft = {
  referenceId: 'TEST-001',
  railwayLocation: 'Учебный участок',
  roadName: 'Условная дорога',
  roadOwner: 'Учебный владелец',
  cardReference: 'Вымышленная карточка',
  cardUpdatedAt: '2026-09-26',
  verifiedAt: '',
  notes: 'Без реальных данных',
}

describe('local SQLite registries', () => {
  it('keeps crossing revisions, rejects stale edits, and persists only in a local file', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'tod-registry-'))
    directories.push(directory)
    const path = join(directory, 'registry.sqlite')
    const store = new RegistryStore(path, () => '2026-09-26T12:00:00.000Z')
    try {
      expect(store.listNormative()).toHaveLength(4)
      expect(store.listNormative().every((row) => row.reviewStatus === 'needs-review')).toBe(true)
      expect(store.listCrossings()).toEqual([])
      expect(store.saveCrossing(crossing, 0).revision).toBe(1)
      expect(
        store.saveCrossing({ ...crossing, roadOwner: 'Другой учебный владелец' }, 1).revision,
      ).toBe(2)
      expect(() => store.saveCrossing(crossing, 1)).toThrow(RevisionConflict)
      expect(store.history('crossings', 'TEST-001').map((row) => row.revision)).toEqual([1, 2])
      const backupName = await store.createBackup()
      const backupPath = join(directory, 'backups', backupName)
      expect(existsSync(backupPath)).toBe(true)
      const restored = new RegistryStore(backupPath)
      try {
        expect(restored.listCrossings()).toMatchObject([{ referenceId: 'TEST-001', revision: 2 }])
        expect(restored.history('crossings', 'TEST-001')).toHaveLength(2)
      } finally {
        restored.close()
      }
    } finally {
      store.close()
    }
    const reopened = new RegistryStore(path)
    try {
      expect(reopened.listCrossings()).toMatchObject([{ referenceId: 'TEST-001', revision: 2 }])
      expect(reopened.listNormative()).toHaveLength(4)
    } finally {
      reopened.close()
    }
  })

  it('requires date and reviewer to mark a normative entry checked', () => {
    const store = new RegistryStore(':memory:')
    try {
      const entry = store.listNormative()[0]!
      const { revision, updatedAt: _updatedAt, ...draft } = entry
      void _updatedAt
      expect(normativeDraftSchema.safeParse({ ...draft, reviewStatus: 'checked' }).success).toBe(
        false,
      )
      expect(
        store.saveNormative(
          {
            ...draft,
            reviewStatus: 'checked',
            checkedAt: '2026-09-26',
            reviewer: 'Тестовый специалист',
          },
          revision,
        ).revision,
      ).toBe(2)
    } finally {
      store.close()
    }
  })

  it('keeps immutable project revisions, rejects stale saves and restores a previous version', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'tod-project-'))
    directories.push(directory)
    const path = join(directory, 'registry.sqlite')
    const scheme = importSchemeJson(fixture).scheme
    const store = new RegistryStore(path, () => '2026-09-26T12:00:00.000Z')
    try {
      expect(store.listProjects()).toEqual([])
      expect(store.saveProject(scheme, 0).revision).toBe(1)
      expect(store.saveProject(scheme, 1).revision).toBe(1)
      const changed = {
        ...scheme,
        parameters: { ...scheme.parameters, locationText: 'Изменённый учебный участок' },
      }
      expect(store.saveProject(changed, 1).revision).toBe(2)
      expect(() => store.saveProject(scheme, 1)).toThrow(RevisionConflict)
      expect(store.listProjects()).toMatchObject([
        {
          id: scheme.id,
          referenceId: 'TEST-001',
          revision: 2,
          locationText: 'Изменённый учебный участок',
        },
      ])
      expect(store.listProjectRevisions(scheme.id).map((entry) => entry.revision)).toEqual([2, 1])
      expect(store.getProjectRevision(scheme.id, 1)?.scheme).toEqual(scheme)
      expect(store.restoreProject(scheme.id, 1, 2)).toMatchObject({ revision: 3, scheme })
      expect(store.restoreProject(scheme.id, 1, 3)).toMatchObject({ revision: 4, scheme })
      expect(store.getProjectRevision(scheme.id, 2)?.scheme.parameters.locationText).toBe(
        'Изменённый учебный участок',
      )
      expect(store.getProject(scheme.id)?.scheme.source.originalJson).toBe(fixture)
      const backupName = await store.createBackup()
      const backup = new RegistryStore(join(directory, 'backups', backupName))
      try {
        expect(backup.listProjectRevisions(scheme.id)).toHaveLength(4)
      } finally {
        backup.close()
      }
    } finally {
      store.close()
    }
    const reopened = new RegistryStore(path)
    try {
      expect(reopened.getProject(scheme.id)?.revision).toBe(4)
      expect(reopened.getProject(scheme.id)?.scheme.source.originalJson).toBe(fixture)
    } finally {
      reopened.close()
    }
  })

  it('migrates a version 3 database without losing the existing manual registry', () => {
    const directory = mkdtempSync(join(tmpdir(), 'tod-v3-upgrade-'))
    directories.push(directory)
    const path = join(directory, 'registry.sqlite')
    const current = new RegistryStore(path)
    current.saveCrossing(crossing, 0)
    current.close()
    const old = new DatabaseSync(path)
    old.exec('DROP TABLE project_revisions; DROP TABLE project_drafts; PRAGMA user_version = 3;')
    old.close()

    const migrated = new RegistryStore(path)
    try {
      expect(migrated.listCrossings()).toMatchObject([{ referenceId: 'TEST-001', revision: 1 }])
      expect(migrated.listProjects()).toEqual([])
      expect(migrated.saveProject(importSchemeJson(fixture).scheme, 0).revision).toBe(1)
    } finally {
      migrated.close()
    }
    const database = new DatabaseSync(path)
    expect(database.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 4 })
    database.close()
  })
})
