import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { openDatabase } from '../database/connection'
import { migrateDatabase } from '../database/migration-runner'
import { ProjectSourceStore } from '../projects/project-source-store'
import { ProjectRepository } from '../projects/project-repository'
import { RecoveryRepository } from '../recovery/recovery-repository'
import { RevisionConflict } from '../storage-errors'
import { importSchemeJson } from '../../src/domain/import'
import { movePlacement } from '../../src/domain/placement-workspace'
import {
  createPlacementDraft,
  removePlacement,
  restoreRoadPlacement,
} from '../../src/domain/edit-placements'
import {
  prepareJunctionWarnings,
  applyJunctionWarnings,
} from '../../src/domain/junction-warning-proposals'

it('persists warning provenance, manual exclusions and incomplete input alongside existing tee history', () => {
  const db = openDatabase(':memory:'),
    now = () => '2026-11-04T00:00:00.000Z'
  try {
    migrateDatabase(db, { path: ':memory:', now })
    const sources = new ProjectSourceStore(db),
      projects = new ProjectRepository(db, sources, now),
      recovery = new RecoveryRepository(db, sources, now)
    const base = importSchemeJson(
      readFileSync('tests/fixtures/frozen/projects/project-v16-junction-warning-b34.json', 'utf8'),
    ).scheme
    const id = base.roadLayout.links.find(
      (link) => link.calculation?.ruleId === 'project-junction-warning-v1',
    )!.placementId
    projects.save(base, 0)
    const modified = movePlacement(base, id, 10, 0),
      excluded = removePlacement(modified, id)
    projects.save(excluded, 1)
    expect(projects.get(base.id)?.scheme).toEqual(excluded)
    expect(applyJunctionWarnings(excluded, prepareJunctionWarnings(excluded, [2]))).toBe(excluded)
    expect(restoreRoadPlacement(excluded, id)).toEqual(modified)
    const draft = createPlacementDraft(
      base.placements.find((p) => p.id === id)!,
      base.roadLayout,
    )
    if (draft.kind !== 'sign-post') throw Error('Post expected')
    draft.roadLink!.installationKnown = true
    draft.roadLink!.installationMetres = '-'
    const input = {
        sessionId: randomUUID(),
        scheme: base,
        baseRevision: 1,
        detailsDraft: null,
        placementDraft: draft,
        fileName: 'учебное-примыкание.json',
        expectedVersion: 0,
      },
      ownerId = randomUUID()
    recovery.save({ input, ownerId })
    expect(recovery.get(input.sessionId, { ownerId })).toMatchObject({
      scheme: base,
      placementDraft: draft,
      version: 1,
    })
    expect(() => recovery.save({ input, ownerId })).toThrow(RevisionConflict)
    expect(projects.restore(base.id, 1, 2)).toMatchObject({ scheme: base, revision: 3 })
    expect(projects.getRevision(base.id, 2)?.scheme).toEqual(excluded)
    expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 13 })
  } finally {
    db.close()
  }
})
