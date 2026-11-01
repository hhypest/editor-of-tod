import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { importSchemeJson } from '../../src/domain/import'
import { createPlacementDraft, savePlacement } from '../../src/domain/edit-placements'
import { openDatabase } from '../database/connection'
import { migrateDatabase } from '../database/migration-runner'
import { ProjectSourceStore } from '../projects/project-source-store'
import { RecoveryRepository } from '../recovery/recovery-repository'
import { RevisionConflict } from '../storage-errors'

it('round-trips incomplete association input in SQLite v13 and preserves the applied model on stale writes', () => {
  const db = openDatabase(':memory:')
  try {
    const now = () => '2026-11-01T20:00:00.000Z'
    migrateDatabase(db, { path: ':memory:', now })
    const repository = new RecoveryRepository(db, new ProjectSourceStore(db), now)
    const scheme = importSchemeJson(
      readFileSync('tests/fixtures/frozen/projects/project-v12-native-b34.json', 'utf8'),
    ).scheme
    const link = scheme.roadLayout.links[0]!,
      post = scheme.placements.find((item) => item.id === link.placementId)!
    const draft = createPlacementDraft(post, scheme.roadLayout)
    if (draft.kind !== 'sign-post' || !draft.roadLink) throw Error('Post required')
    draft.roadLink.installationKnown = true
    draft.roadLink.installationMetres = '-'
    const input = {
      sessionId: randomUUID(),
      scheme,
      baseRevision: null,
      detailsDraft: null,
      placementDraft: draft,
      fileName: 'учебный.json',
      expectedVersion: 0,
    }
    const ownerId = randomUUID()
    repository.save({ input, ownerId })
    expect(repository.get(input.sessionId, { ownerId })?.placementDraft).toEqual(draft)
    expect(() => savePlacement(scheme, draft)).toThrow('Расстояние установки стойки')
    draft.roadLink.installationMetres = '50,'
    repository.save({ input: { ...input, expectedVersion: 1 }, ownerId })
    expect(() => repository.save({ input, ownerId })).toThrow(RevisionConflict)
    expect(repository.get(input.sessionId, { ownerId })).toMatchObject({
      scheme,
      placementDraft: draft,
      version: 2,
    })
    expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 13 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM project_drafts').get()).toEqual({ count: 0 })
  } finally {
    db.close()
  }
})
