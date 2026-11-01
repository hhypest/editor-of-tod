import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { importSchemeJson } from '../../src/domain/import'
import { newRoadNodeDraft } from '../../src/domain/edit-road-nodes'
import { openDatabase } from '../database/connection'
import { migrateDatabase } from '../database/migration-runner'
import { ProjectSourceStore } from '../projects/project-source-store'
import { RecoveryRepository } from '../recovery/recovery-repository'
import { RevisionConflict } from '../storage-errors'

describe('recoverable road-node form on existing SQLite v13', () => {
  it('stores invalid/incomplete input separately, reuses its source and preserves the applied project on conflicts', () => {
    const db = openDatabase(':memory:')
    try {
      const now = () => '2026-11-01T08:00:00.000Z'
      migrateDatabase(db, { path: ':memory:', now })
      const recovery = new RecoveryRepository(db, new ProjectSourceStore(db), now)
      const scheme = importSchemeJson(readFileSync('tests/fixtures/manual-v1.json', 'utf8')).scheme
      const road = newRoadNodeDraft('junction')
      road.metres = '-'
      road.name = 'Не применено'
      const input = {
        sessionId: randomUUID(),
        scheme,
        baseRevision: null,
        detailsDraft: null,
        placementDraft: road,
        fileName: 'учебный.json',
        expectedVersion: 0,
      }
      const ownerId = randomUUID()
      recovery.save({ input, ownerId })
      expect(recovery.get(input.sessionId, { ownerId })).toMatchObject({
        scheme,
        placementDraft: road,
        version: 1,
      })
      const next = { ...road, metres: '', name: 'Продолжение ввода' }
      recovery.save({ input: { ...input, expectedVersion: 1, placementDraft: next }, ownerId })
      expect(() => recovery.save({ input, ownerId })).toThrow(RevisionConflict)
      const saved = recovery.get(input.sessionId, { ownerId })!
      expect(saved.scheme).toEqual(scheme)
      expect(saved.placementDraft).toEqual(next)
      expect(saved.scheme.roadLayout.nodes).toEqual([])
      expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 13 })
      expect(db.prepare('SELECT COUNT(*) AS count FROM project_sources').get()).toEqual({
        count: 1,
      })
      expect(db.prepare('SELECT COUNT(*) AS count FROM project_drafts').get()).toEqual({ count: 0 })
    } finally {
      db.close()
    }
  })
})
