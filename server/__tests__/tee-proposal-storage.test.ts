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
import { createPlacementDraft, removePlacement } from '../../src/domain/edit-placements'
import { prepareTeeProposals, applyTeeProposals } from '../../src/domain/tee-proposals'

it('preserves calculated, modified and excluded states in real SQLite history and recovery', () => {
  const db = openDatabase(':memory:'),
    now = () => '2026-11-03T15:00:00.000Z'
  try {
    migrateDatabase(db, { path: ':memory:', now })
    const sources = new ProjectSourceStore(db),
      projects = new ProjectRepository(db, sources, now),
      recovery = new RecoveryRepository(db, sources, now)
    const base = importSchemeJson(
      readFileSync('tests/fixtures/frozen/projects/project-v15-tee-proposals-b34.json', 'utf8'),
    ).scheme
    projects.save(base, 0)
    const edited = removePlacement(movePlacement(base, 2, 10, 0), 3)
    projects.save(edited, 1)
    expect(projects.get(base.id)?.scheme).toEqual(edited)
    expect(projects.getRevision(base.id, 1)?.scheme).toEqual(base)
    expect(applyTeeProposals(edited, prepareTeeProposals(edited, [1]))).toBe(edited)
    const draft = createPlacementDraft(edited.placements[0]!, edited.roadLayout)
    if (draft.kind !== 'sign-post') throw Error('Post expected')
    draft.roadLink!.branchPlacement!.alongSvg = '-'
    const input = {
        sessionId: randomUUID(),
        scheme: edited,
        baseRevision: 2,
        detailsDraft: null,
        placementDraft: draft,
        fileName: 'учебный.json',
        expectedVersion: 0,
      },
      ownerId = randomUUID()
    recovery.save({ input, ownerId })
    expect(recovery.get(input.sessionId, { ownerId })).toMatchObject({
      scheme: edited,
      placementDraft: draft,
      version: 1,
    })
    expect(() => recovery.save({ input, ownerId })).toThrow(RevisionConflict)
    expect(projects.restore(base.id, 1, 2)).toMatchObject({ scheme: base, revision: 3 })
    expect(
      projects
        .get(base.id)
        ?.scheme.roadLayout.links.every((link) => link.calculation?.state === 'automatic'),
    ).toBe(true)
    expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 13 })
  } finally {
    db.close()
  }
})
