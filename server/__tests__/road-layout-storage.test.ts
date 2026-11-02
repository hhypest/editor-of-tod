import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { legacyRoadFixture } from '../../tests/fixtures/road-layout'
import { importSchemeJson } from '../../src/domain/import'
import { removePlacement } from '../../src/domain/edit-placements'
import { openDatabase } from '../database/connection'
import { migrateDatabase } from '../database/migration-runner'
import { ProjectSourceStore } from '../projects/project-source-store'
import { ProjectRepository } from '../projects/project-repository'
import { RecoveryRepository } from '../recovery/recovery-repository'

const connections: DatabaseSync[] = []
afterEach(() => {
  for (const db of connections.splice(0)) db.close()
})

function setup() {
  const db = openDatabase(':memory:')
  connections.push(db)
  const now = () => '2026-11-01T03:00:00.000Z'
  migrateDatabase(db, { path: ':memory:', now })
  const sources = new ProjectSourceStore(db)
  return {
    db,
    projects: new ProjectRepository(db, sources, now),
    recovery: new RecoveryRepository(db, sources, now),
  }
}
function project() {
  return importSchemeJson(
    JSON.stringify(
      legacyRoadFixture(JSON.parse(readFileSync('tests/fixtures/manual-v1.json', 'utf8'))),
    ),
  ).scheme
}

describe('v12 road data through the production SQLite owners', () => {
  it('saves nodes and links, keeps old history, and restores a deleted link with a new revision', () => {
    const { db, projects } = setup()
    const first = project()
    projects.save(first, 0)
    expect(projects.get(first.id)?.scheme).toEqual(first)
    const edited = removePlacement(first, 1002)
    projects.save(edited, 1)
    expect(projects.get(first.id)?.scheme).toEqual(edited)
    expect(projects.getRevision(first.id, 1)?.scheme).toEqual(first)
    const restored = projects.restore(first.id, 1, 2)
    expect(restored).toMatchObject({ revision: 3, scheme: first })
    expect(projects.getRevision(first.id, 2)?.scheme).toEqual(edited)
    expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 13 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM project_sources').get()).toEqual({ count: 1 })
  })

  it('reads v11 project/history in memory and only upgrades the explicitly saved revision', () => {
    const { db, projects } = setup()
    const current = project()
    const { roadLayout: _layout, ...rest } = current
    void _layout
    const payload = JSON.stringify({ ...rest, schemaVersion: 11 })
    db.prepare(
      `INSERT INTO project_drafts (id, revision, scheme_json, reference_id, location_text, template_code, updated_at) VALUES (?, 1, ?, ?, '', 'b33', '2026-11-01T00:00:00.000Z')`,
    ).run(current.id, payload, current.crossing.referenceId)
    db.prepare(
      `INSERT INTO project_revisions (id, revision, scheme_json, updated_at) VALUES (?, 1, ?, '2026-11-01T00:00:00.000Z')`,
    ).run(current.id, payload)
    expect(projects.get(current.id)).toMatchObject({ scheme: current, storedSchemaVersion: 11 })
    expect(projects.getRevision(current.id, 1)?.scheme).toEqual(current)
    expect(db.prepare('SELECT scheme_json FROM project_drafts').get()).toEqual({
      scheme_json: payload,
    })
    expect(projects.save(current, 1).revision).toBe(2)
    expect(projects.get(current.id)?.storedSchemaVersion).toBe(13)
    expect(
      db.prepare('SELECT scheme_json FROM project_revisions WHERE revision = 1').get(),
    ).toEqual({ scheme_json: payload })
  })

  it('recovers v12 nodes/links and reads an old v11 recovery without rewriting it', () => {
    const { db, recovery } = setup()
    const scheme = project()
    const ownerId = randomUUID(),
      sessionId = randomUUID()
    recovery.save({
      ownerId,
      input: {
        sessionId,
        scheme,
        baseRevision: null,
        detailsDraft: null,
        placementDraft: null,
        fileName: 'fictional-road.json',
        expectedVersion: 0,
      },
    })
    expect(recovery.get(sessionId, { ownerId })?.scheme).toEqual(scheme)
    const { roadLayout: _layout, ...rest } = scheme
    void _layout
    const payload = JSON.stringify({ ...rest, schemaVersion: 11 })
    db.prepare('UPDATE project_recovery SET scheme_json = ? WHERE session_id = ?').run(
      payload,
      sessionId,
    )
    expect(recovery.get(sessionId, { ownerId })?.scheme).toEqual(scheme)
    expect(db.prepare('SELECT scheme_json FROM project_recovery').get()).toEqual({
      scheme_json: payload,
    })
  })
})
