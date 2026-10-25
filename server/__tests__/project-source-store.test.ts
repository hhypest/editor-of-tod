import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { importSchemeJson } from '../../src/domain/import'
import { schemeSchema } from '../../src/domain/model'
import { openDatabase } from '../database/connection'
import { migrateDatabase } from '../database/migration-runner'
import { ProjectSourceStore } from '../projects/project-source-store'

const scheme = importSchemeJson(readFileSync('tests/fixtures/manual-v1.json', 'utf8')).scheme
const native = schemeSchema.parse({ ...scheme, source: { kind: 'created-in-editor' } })
const connections: DatabaseSync[] = []
afterEach(() => {
  for (const db of connections.splice(0)) db.close()
})

function setup(migrate = true) {
  const db = openDatabase(':memory:')
  connections.push(db)
  if (migrate) migrateDatabase(db, { path: ':memory:', now: () => '2030-01-01T00:00:00.000Z' })
  return { db, sources: new ProjectSourceStore(db) }
}

function sourceCount(db: DatabaseSync) {
  return (db.prepare('SELECT COUNT(*) AS count FROM project_sources').get() as { count: number })
    .count
}

describe('ProjectSourceStore on the caller-owned SQLite connection', () => {
  it('round-trips native projects without reading source tables or running migrations', () => {
    const { db, sources } = setup(false)
    const payload = sources.encode(native)
    expect(payload).toBe(JSON.stringify(native))
    expect(sources.decode(payload)).toEqual(native)
    sources.removeUnreferenced(payload)
    expect(db.prepare('SELECT name FROM sqlite_master').all()).toEqual([])
  })

  it('reads an older inline source without rewriting its snapshot or creating a source row', () => {
    const { db, sources } = setup()
    const payload = readFileSync(
      'tests/fixtures/frozen/projects/project-v6-imported-b34.json',
      'utf8',
    )
    expect(sources.decode(payload)).toEqual(importSchemeJson(payload).scheme)
    expect(sourceCount(db)).toBe(0)
    expect(JSON.parse(payload).schemaVersion).toBe(6)
  })

  it('deduplicates identical UTF-8 bytes and returns a self-contained source without the SQLite hash', () => {
    const { db, sources } = setup()
    const originalJson = '{ "учебный": "исходник" }\r\n  '
    const imported = schemeSchema.parse({ ...scheme, source: { ...scheme.source, originalJson } })
    const sha256 = createHash('sha256').update(originalJson, 'utf8').digest('hex')
    const payload = sources.encode(imported)
    const other = sources.encode({ ...imported, id: randomUUID() })
    expect(sourceCount(db)).toBe(1)
    expect(
      db.prepare('SELECT original_json FROM project_sources WHERE sha256 = ?').get(sha256),
    ).toEqual({ original_json: originalJson })
    expect(JSON.parse(payload).source).toEqual({
      kind: 'legacy-html-v1',
      importedAt: scheme.source.kind === 'legacy-html-v1' ? scheme.source.importedAt : '',
      originalJsonSha256: sha256,
    })
    expect(sources.decode(payload)).toEqual(imported)
    expect(sources.decode(other).source).toEqual(imported.source)
    expect(sources.decode(payload).source).not.toHaveProperty('originalJsonSha256')
    // Distinct original bytes must never collapse into the same source.
    sources.encode(
      schemeSchema.parse({
        ...imported,
        source: { ...imported.source, originalJson: originalJson + ' ' },
      }),
    )
    expect(sourceCount(db)).toBe(2)
  })

  it.each([null, 123, 'f'.repeat(63), 'F'.repeat(64)])(
    'rejects a malformed reference before querying sources: %s',
    (hash) => {
      const { sources } = setup(false)
      expect(() =>
        sources.decode(
          JSON.stringify({ ...scheme, source: { ...scheme.source, originalJsonSha256: hash } }),
        ),
      ).toThrow(
        'Ссылка на исходный файл проекта повреждена. Восстановите проект из резервной копии.',
      )
    },
  )

  it.each(['missing', 'corrupted'])(
    'refuses a %s source instead of returning an incomplete project',
    (state) => {
      const { db, sources } = setup()
      const payload = sources.encode(scheme)
      if (state === 'missing') db.exec('DELETE FROM project_sources')
      else db.prepare('UPDATE project_sources SET original_json = ?').run('synthetic corruption')
      expect(() => sources.decode(payload)).toThrow(
        'Исходный файл проекта отсутствует или повреждён. Восстановите проект из резервной копии.',
      )
    },
  )

  it.each(['project_drafts', 'project_revisions', 'project_recovery'])(
    'retains a source while %s references it, then removes the last unreferenced source',
    (table) => {
      const { db, sources } = setup()
      const payload = sources.encode(scheme)
      const other = sources.encode(
        schemeSchema.parse({
          ...scheme,
          source: { ...scheme.source, originalJson: 'unrelated fictional source' },
        }),
      )
      // Revision FK requires a current draft; only the tested table has a SHA reference.
      if (table !== 'project_recovery') {
        db.prepare(
          `INSERT INTO project_drafts (id, revision, scheme_json, reference_id, location_text, template_code, updated_at) VALUES (?, 1, ?, 'TEST', '', 'B.34', '2030-01-01')`,
        ).run(scheme.id, table === 'project_drafts' ? payload : JSON.stringify(native))
      }
      if (table === 'project_revisions') {
        db.prepare(
          `INSERT INTO project_revisions (id, revision, scheme_json, updated_at) VALUES (?, 1, ?, '2030-01-01')`,
        ).run(scheme.id, payload)
      }
      if (table === 'project_recovery') {
        db.prepare(
          `INSERT INTO project_recovery (session_id, version, scheme_json, file_name, reference_id, updated_at) VALUES (?, 1, ?, 'fictional.json', 'TEST', '2030-01-01')`,
        ).run(randomUUID(), payload)
      }
      db.exec('BEGIN IMMEDIATE')
      sources.removeUnreferenced(payload)
      expect(sourceCount(db)).toBe(2)
      db.exec(`DELETE FROM ${table}`)
      sources.removeUnreferenced(payload)
      expect(sourceCount(db)).toBe(1)
      expect(sources.decode(other).source).toHaveProperty(
        'originalJson',
        'unrelated fictional source',
      )
      db.exec('COMMIT')
    },
  )

  it('leaves source writes and cleanup inside the caller transaction, including rollback', () => {
    const { db, sources } = setup()
    db.exec('BEGIN IMMEDIATE')
    const payload = sources.encode(scheme)
    expect(sourceCount(db)).toBe(1)
    expect(db.isTransaction).toBe(true)
    db.exec('ROLLBACK')
    expect(sourceCount(db)).toBe(0)
    sources.encode(scheme)
    db.exec('BEGIN IMMEDIATE')
    sources.removeUnreferenced(payload)
    expect(sourceCount(db)).toBe(0)
    expect(db.isTransaction).toBe(true)
    db.exec('ROLLBACK')
    expect(sources.decode(payload)).toEqual(scheme)
  })
})
