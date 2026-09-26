import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { normativeDraftSchema, type CrossingDraft } from '../../src/domain/registry'
import { RegistryStore, RevisionConflict } from '../store'

const directories: string[] = []
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
})
