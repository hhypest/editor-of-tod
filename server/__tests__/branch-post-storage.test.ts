import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { openDatabase } from '../database/connection'
import { migrateDatabase } from '../database/migration-runner'
import { ProjectSourceStore } from '../projects/project-source-store'
import { ProjectRepository } from '../projects/project-repository'
import { RecoveryRepository } from '../recovery/recovery-repository'
import { importSchemeJson } from '../../src/domain/import'
import { movePlacement } from '../../src/domain/placement-workspace'
import { createPlacementDraft } from '../../src/domain/edit-placements'
import { RevisionConflict } from '../storage-errors'

function owners() {
  const db = openDatabase(':memory:'),
    now = () => '2026-11-02T04:00:00.000Z'
  migrateDatabase(db, { path: ':memory:', now })
  const sources = new ProjectSourceStore(db)
  return {
    db,
    projects: new ProjectRepository(db, sources, now),
    recovery: new RecoveryRepository(db, sources, now),
  }
}

it('stores v13 branch geometry in history and partial branch input in the existing recovery slot', () => {
  const { db, projects, recovery } = owners()
  try {
    const scheme = importSchemeJson(
      readFileSync('tests/fixtures/frozen/projects/project-v13-branch-b34.json', 'utf8'),
    ).scheme
    projects.save(scheme, 0)
    const moved = movePlacement(scheme, 1, 10, 20)
    projects.save(moved, 1)
    expect(projects.get(scheme.id)?.scheme).toEqual(moved)
    expect(projects.getRevision(scheme.id, 1)?.scheme).toEqual(scheme)
    expect(projects.restore(scheme.id, 1, 2)).toMatchObject({ scheme, revision: 3 })
    const draft = createPlacementDraft(scheme.placements[0]!, scheme.roadLayout)
    if (draft.kind !== 'sign-post' || !draft.roadLink?.branchPlacement)
      throw Error('Branch draft expected')
    draft.roadLink.branchPlacement.alongSvg = '-'
    const input = {
        sessionId: randomUUID(),
        scheme,
        baseRevision: 3,
        detailsDraft: null,
        placementDraft: draft,
        fileName: 'учебный.json',
        expectedVersion: 0,
      },
      ownerId = randomUUID()
    recovery.save({ input, ownerId })
    expect(recovery.get(input.sessionId, { ownerId })).toMatchObject({
      scheme,
      placementDraft: draft,
      version: 1,
    })
    draft.roadLink.branchPlacement.alongSvg = ''
    recovery.save({ input: { ...input, expectedVersion: 1 }, ownerId })
    expect(() => recovery.save({ input, ownerId })).toThrow(RevisionConflict)
    expect(recovery.get(input.sessionId, { ownerId })?.placementDraft).toEqual(draft)
    expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 13 })
    expect(projects.get(scheme.id)?.scheme).toEqual(scheme)
  } finally {
    db.close()
  }
})

it('reads v12 project/history as v13 without rewriting or adopting any branch', () => {
  const { db, projects } = owners()
  try {
    const payload = readFileSync(
        'tests/fixtures/frozen/projects/project-v12-native-b34.json',
        'utf8',
      ),
      original = JSON.parse(payload)
    db.prepare(
      "INSERT INTO project_drafts (id, revision, scheme_json, reference_id, location_text, template_code, updated_at) VALUES (?, 1, ?, ?, '', 'b34', '2026-11-02T00:00:00.000Z')",
    ).run(original.id, payload, original.crossing.referenceId)
    db.prepare(
      "INSERT INTO project_revisions (id, revision, scheme_json, updated_at) VALUES (?, 1, ?, '2026-11-02T00:00:00.000Z')",
    ).run(original.id, payload)
    const current = projects.get(original.id)!
    expect(current.storedSchemaVersion).toBe(12)
    expect(current.scheme).toEqual({ ...original, schemaVersion: 13 })
    expect(db.prepare('SELECT scheme_json FROM project_drafts').get()).toEqual({
      scheme_json: payload,
    })
    expect(projects.save(current.scheme, 1).revision).toBe(2)
    expect(projects.get(original.id)?.storedSchemaVersion).toBe(13)
    expect(
      db.prepare('SELECT scheme_json FROM project_revisions WHERE revision = 1').get(),
    ).toEqual({ scheme_json: payload })
  } finally {
    db.close()
  }
})
