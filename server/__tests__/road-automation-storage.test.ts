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
import { prepareRoadAutomation, applyRoadAutomation } from '../../src/domain/road-automation'
import { removeRoadNode } from '../../src/domain/edit-road-nodes'
import { createSchemeDetailsDraft } from '../../src/domain/edit-details'

it('persists the full plan, detached manual edits and incomplete notes with history and recovery', () => {
  const db = openDatabase(':memory:'),
    now = () => '2026-11-04T00:00:00.000Z'
  try {
    migrateDatabase(db, { path: ':memory:', now })
    const sources = new ProjectSourceStore(db),
      projects = new ProjectRepository(db, sources, now),
      recovery = new RecoveryRepository(db, sources, now)
    const base = importSchemeJson(
      readFileSync('tests/fixtures/frozen/projects/project-v17-road-automation-b34.json', 'utf8'),
    ).scheme
    const id = base.roadLayout.links.find(
      (link) => link.calculation?.ruleId === 'project-road-layout-v1' && link.branchPlacement,
    )!.placementId
    projects.save(base, 0)
    const modified = movePlacement(base, id, 10, 0),
      excluded = removePlacement(modified, id)
    projects.save(excluded, 1)
    expect(projects.get(base.id)?.scheme).toEqual(excluded)
    expect(
      applyRoadAutomation(excluded, prepareRoadAutomation(excluded)).placements.some(
        (p) => p.id === id,
      ),
    ).toBe(false)
    const detached = removeRoadNode(
      excluded,
      base.roadLayout.links.find((l) => l.placementId === id)!.nodeId,
    )
    projects.save(detached, 2)
    expect(projects.get(base.id)?.scheme).toEqual(detached)
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
        detailsDraft: {
          ...createSchemeDetailsDraft(base),
          roadNotesText: 'Неприменённое примечание',
        },
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
    expect(projects.restore(base.id, 1, 3)).toMatchObject({ scheme: base, revision: 4 })
    expect(projects.getRevision(base.id, 2)?.scheme).toEqual(excluded)
    expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 13 })
  } finally {
    db.close()
  }
})
