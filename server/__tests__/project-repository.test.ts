import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { importSchemeJson } from '../../src/domain/import'
import type { Scheme } from '../../src/domain/model'
import { MAX_LOCAL_PROJECT_BYTES } from '../../src/domain/local-projects'
import { openDatabase } from '../database/connection'
import { migrateDatabase } from '../database/migration-runner'
import { ProjectRepository } from '../projects/project-repository'
import { ProjectSourceStore } from '../projects/project-source-store'
import { ProjectTooLarge, RevisionConflict } from '../storage-errors'

const scheme = importSchemeJson(readFileSync('tests/fixtures/manual-v1.json', 'utf8')).scheme
const connections: DatabaseSync[] = []
const directories: string[] = []
afterEach(() => {
  for (const db of connections.splice(0)) db.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function setup(path = ':memory:', now = () => '2030-01-01T00:00:00.000Z') {
  const db = openDatabase(path)
  connections.push(db)
  migrateDatabase(db, { path, now })
  const sources = new ProjectSourceStore(db)
  return { db, sources, projects: new ProjectRepository(db, sources, now) }
}

function sourceCount(db: DatabaseSync) {
  return (db.prepare('SELECT COUNT(*) AS count FROM project_sources').get() as { count: number })
    .count
}

describe('ProjectRepository independently of RegistryStore', () => {
  it('returns empty/missing results without domain seeding or a clock read', () => {
    const { db, projects } = setup(':memory:', () => {
      throw new Error('Clock must not be read')
    })
    expect(projects.list()).toEqual([])
    expect(projects.listRevisions(scheme.id)).toEqual([])
    expect(projects.get(scheme.id)).toBeNull()
    expect(projects.getRevision(scheme.id, 1)).toBeNull()
    expect(projects.restore(scheme.id, 1, 0)).toBeNull()
    expect(db.prepare('SELECT COUNT(*) AS count FROM normative').get()).toEqual({ count: 0 })
    expect(db.isTransaction).toBe(false)
  })

  it('checks expectedRevision before no-op, and preserves explicit force/restore and immutable history', () => {
    let reads = 0
    const { projects } = setup(':memory:', () => `2030-01-01T00:00:0${++reads}.000Z`)

    const first = projects.save(scheme, 0)
    expect(projects.save(scheme, 1)).toEqual(first)
    expect(reads).toBe(1)
    expect(() => projects.save(scheme, 0)).toThrow(RevisionConflict)
    expect(reads).toBe(1)
    expect(projects.save(scheme, 1, true).revision).toBe(2)
    expect(projects.restore(scheme.id, 1, 2)).toMatchObject({ scheme, revision: 3 })
    expect(projects.restore(scheme.id, 99, 3)).toBeNull()
    expect(() => projects.restore(scheme.id, 1, 2)).toThrow(RevisionConflict)
    expect(projects.listRevisions(scheme.id).map((row) => row.revision)).toEqual([3, 2, 1])
    expect(projects.getRevision(scheme.id, 1)).toEqual({ ...first, storedSchemaVersion: 12 })
    expect(reads).toBe(3)
  })

  it('rejects a stale writer on another SQLite connection without inserting its source', () => {
    const directory = mkdtempSync(join(tmpdir(), 'tod-project-race-'))
    directories.push(directory)
    const path = join(directory, 'registry.sqlite')
    const one = setup(path)
    const two = setup(path)
    one.projects.save(scheme, 0)
    const stale = two.projects.get(scheme.id)!
    const winner = {
      ...scheme,
      parameters: { ...scheme.parameters, locationText: 'Учебный победитель' },
    }
    one.projects.save(winner, 1)
    const edited = {
      ...scheme,
      source: { ...scheme.source, originalJson: '{"fictional":"losing source"}' },
    }
    expect(() => two.projects.save(edited, stale.revision)).toThrow(RevisionConflict)
    expect(two.projects.get(scheme.id)?.scheme).toEqual(winner)
    expect(sourceCount(two.db)).toBe(1)
    expect(two.db.isTransaction).toBe(false)
    expect(two.projects.save(edited, 2).revision).toBe(3)
    expect(one.projects.get(scheme.id)?.scheme).toEqual(edited)
    expect(one.projects.getRevision(scheme.id, 2)?.scheme).toEqual(winner)
  })

  it('reads frozen inline history without writes, and upgrades only the explicitly saved current snapshot', () => {
    const { db, projects } = setup()
    const payload = readFileSync(
      'tests/fixtures/frozen/projects/project-v6-imported-b34.json',
      'utf8',
    )
    const current = importSchemeJson(payload).scheme
    db.prepare(
      `INSERT INTO project_drafts (id, revision, scheme_json, reference_id, location_text, template_code, updated_at) VALUES (?, 1, ?, ?, '', 'b34', '2026-01-01T00:00:00.000Z')`,
    ).run(current.id, payload, current.crossing.referenceId)
    db.prepare(
      `INSERT INTO project_revisions (id, revision, scheme_json, updated_at) VALUES (?, 1, ?, '2026-01-01T00:00:00.000Z')`,
    ).run(current.id, payload)
    expect(projects.get(current.id)).toMatchObject({ scheme: current, storedSchemaVersion: 6 })
    expect(projects.getRevision(current.id, 1)).toMatchObject({
      scheme: current,
      storedSchemaVersion: 6,
    })
    expect(db.prepare('SELECT scheme_json FROM project_drafts').get()).toEqual({
      scheme_json: payload,
    })
    expect(sourceCount(db)).toBe(0)
    expect(projects.save(current, 1).revision).toBe(2)
    expect(projects.get(current.id)?.storedSchemaVersion).toBe(12)
    expect(projects.save(current, 2).revision).toBe(2)
    expect(
      db.prepare('SELECT scheme_json FROM project_revisions WHERE revision = 1').get(),
    ).toEqual({ scheme_json: payload })
  })

  it('lists only bounded text from the latest snapshot, with stable ordering and no original source', () => {
    let time = '2030-01-01T00:00:00.000Z'
    const { db, projects } = setup(':memory:', () => time)
    const one = { ...scheme, id: '00000000-0000-4000-8000-000000000001' }
    const two = { ...scheme, id: '00000000-0000-4000-8000-000000000002' }
    projects.save(two, 0)
    projects.save(one, 0)
    expect(projects.list().map((row) => row.id)).toEqual([one.id, two.id])
    time = '2030-01-01T00:01:00.000Z'
    const edited = {
      ...two,
      parameters: {
        ...two.parameters,
        directions: { left: 'Д'.repeat(600), right: 'Учебное направление' },
        locationText: 'Новая подпись',
      },
    }
    projects.save(edited, 1)
    db.prepare(
      `UPDATE project_drafts SET scheme_json = json_set(scheme_json, '$.crossing.snapshot', json(?), '$.titleBlock.work.description', 42) WHERE id = ?`,
    ).run('{"location":"Учебное место","roadName":false}', two.id)
    const rows = projects.list()
    expect(rows.map((row) => row.id)).toEqual([two.id, one.id])
    expect(rows[0]).toEqual({
      id: two.id,
      referenceId: two.crossing.referenceId,
      locationText: 'Новая подпись',
      templateCode: two.template.code,
      revision: 2,
      updatedAt: time,
      crossingLocation: 'Учебное место',
      roadName: '',
      directionLeft: 'Д'.repeat(500),
      directionRight: 'Учебное направление',
      workDescription: '',
    })
    expect(JSON.stringify(rows)).not.toContain('originalJson')
    expect(projects.getRevision(two.id, 1)?.scheme).toEqual(two)
  })

  it('rolls back a source projection failure and leaves the connection reusable', () => {
    const { db, sources } = setup()
    const error = new Error('synthetic source projection failure')
    const projects = new ProjectRepository(
      db,
      {
        decode: (payload) => sources.decode(payload),
        encode: (value) => {
          sources.encode(value)
          throw error
        },
      },
      () => '2030-01-01T00:00:00.000Z',
    )
    expect(() => projects.save(scheme, 0)).toThrow(error)
    expect(sourceCount(db)).toBe(0)
    expect(projects.list()).toEqual([])
    expect(projects.listRevisions(scheme.id)).toEqual([])
    expect(db.isTransaction).toBe(false)
    expect(
      new ProjectRepository(db, sources, () => '2030-01-01T00:00:00.000Z').save(scheme, 0).revision,
    ).toBe(1)
  })

  it('does not report a no-op as saved if the existing source checksum is corrupted', () => {
    const { db, projects } = setup()
    projects.save(scheme, 0)
    const before = db.prepare('SELECT * FROM project_drafts').all()
    db.prepare('UPDATE project_sources SET original_json = ?').run('synthetic corruption')
    expect(() => projects.save(scheme, 1)).toThrow(
      'Исходный файл проекта отсутствует или повреждён.',
    )
    expect(db.prepare('SELECT * FROM project_drafts').all()).toEqual(before)
    expect(projects.listRevisions(scheme.id)).toHaveLength(1)
    expect(db.isTransaction).toBe(false)
  })

  it('limits full UTF-8 project bytes before dedup or starting a transaction', () => {
    let clockReads = 0
    const { db, projects } = setup(':memory:', () => {
      clockReads++
      return '2030-01-01T00:00:00.000Z'
    })
    const large: Scheme = {
      ...scheme,
      source: {
        kind: 'legacy-html-v1',
        importedAt: scheme.createdAt,
        originalJson: JSON.stringify({ fictional: '中'.repeat(1_400_000) }),
      },
      placements: Array.from({ length: 2_000 }, (_, index) => ({
        kind: 'element',
        id: index + 1,
        generatedByTemplate: false,
        elementKind: 'text',
        position: { anchor: 'abs', offsetXSvg: 0, ySvg: 0 },
        sizeSvg: { width: 1, height: 1 },
        text: '中'.repeat(5_000),
        fontSizeSvg: 1,
        bold: false,
      })),
      nextPlacementId: 2_001,
    }
    expect(Buffer.byteLength(JSON.stringify(large))).toBeGreaterThan(MAX_LOCAL_PROJECT_BYTES)
    db.exec('BEGIN IMMEDIATE')
    expect(() => projects.save(large, 0)).toThrow(ProjectTooLarge)
    expect(db.isTransaction).toBe(true) // The size gate must neither begin nor roll back caller work.
    expect(clockReads).toBe(0)
    expect(sourceCount(db)).toBe(0)
    expect(projects.list()).toEqual([])
    db.exec('ROLLBACK')
    expect(projects.save({ ...scheme, id: randomUUID() }, 0).revision).toBe(1)
  })
})
