import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { ZodError } from 'zod'
import { afterEach, describe, expect, it } from 'vitest'
import type { CrossingDraft, NormativeDraft } from '../../src/domain/registry'
import { openDatabase } from '../database/connection'
import { migrateDatabase } from '../database/migration-runner'
import { LegacyRegistryRepository } from '../legacy/legacy-registry-repository'
import { RevisionConflict } from '../storage-errors'
import { RevisionConflict as FacadeRevisionConflict } from '../store'

const crossing: CrossingDraft = {
  referenceId: 'test-shared',
  railwayLocation: 'Учебный участок',
  roadName: '',
  roadOwner: '',
  cardReference: '',
  cardUpdatedAt: '',
  verifiedAt: '',
  notes: '',
}
const normative: NormativeDraft = {
  id: 'test-shared',
  documentCode: 'УЧЕБНЫЙ',
  edition: '2030',
  clause: 'Учебный пункт',
  description: 'Вымышленный источник',
  application: '',
  sourceUrl: '',
  reviewStatus: 'needs-review',
  checkedAt: '',
  reviewer: '',
}
const connections: DatabaseSync[] = [],
  directories: string[] = []
afterEach(() => {
  for (const db of connections.splice(0)) db.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})
function setup(path = ':memory:', now = () => '2030-01-01T00:00:00.000Z') {
  const db = openDatabase(path)
  connections.push(db)
  migrateDatabase(db, { path, now })
  return { db, registry: new LegacyRegistryRepository(db, now) }
}

describe('LegacyRegistryRepository independently of the facade', () => {
  it('does not seed, keeps kinds isolated, trims drafts and appends even unchanged saves', () => {
    const { registry } = setup()
    expect(registry.listNormative()).toEqual([])
    expect(registry.listCrossings()).toEqual([])
    expect(FacadeRevisionConflict).toBe(RevisionConflict)
    const first = registry.saveCrossing(
      { ...crossing, referenceId: ' test-shared ', notes: ' Учебная заметка ' },
      0,
    )
    expect(first).toEqual({
      ...crossing,
      notes: 'Учебная заметка',
      revision: 1,
      updatedAt: '2030-01-01T00:00:00.000Z',
    })
    registry.saveNormative({ ...normative, documentCode: ' УЧЕБНЫЙ ' }, 0)
    const { revision: _revision, updatedAt: _time, ...draft } = first
    void _revision
    void _time
    expect(registry.saveCrossing(draft, 1).revision).toBe(2)
    registry.saveCrossing({ ...crossing, referenceId: 'aaa-first' }, 0)
    expect(registry.listCrossings().map((row) => row.referenceId)).toEqual([
      'aaa-first',
      'test-shared',
    ])
    expect(registry.listNormative()).toMatchObject([
      { id: 'test-shared', documentCode: 'УЧЕБНЫЙ', revision: 1 },
    ])
    expect(registry.history('crossings', crossing.referenceId).map((row) => row.revision)).toEqual([
      1, 2,
    ])
    expect(registry.history('normative', normative.id)).toEqual([
      { revision: 1, payload: normative, updatedAt: '2030-01-01T00:00:00.000Z' },
    ])
    expect(registry.history('crossings', 'missing')).toEqual([])
  })

  it('rejects a stale writer from another connection and leaves history immutable on retry', () => {
    const directory = mkdtempSync(join(tmpdir(), 'tod-legacy-race-'))
    directories.push(directory)
    const path = join(directory, 'registry.sqlite')
    const one = setup(path),
      two = setup(path)
    one.registry.saveCrossing(crossing, 0)
    const stale = two.registry.listCrossings()[0]!
    one.registry.saveCrossing({ ...crossing, notes: 'Правка первого окна' }, 1)
    expect(() =>
      two.registry.saveCrossing({ ...crossing, notes: 'Правка второго окна' }, stale.revision),
    ).toThrow(FacadeRevisionConflict)
    expect(two.db.isTransaction).toBe(false)
    expect(two.registry.listCrossings()).toMatchObject([
      { notes: 'Правка первого окна', revision: 2 },
    ])
    expect(
      two.registry.saveCrossing({ ...crossing, notes: 'Повтор после чтения' }, 2).revision,
    ).toBe(3)
    expect(
      one.registry
        .history('crossings', crossing.referenceId)
        .map((row) => [row.revision, row.payload]),
    ).toEqual([
      [1, crossing],
      [2, { ...crossing, notes: 'Правка первого окна' }],
      [3, { ...crossing, notes: 'Повтор после чтения' }],
    ])
  })

  it('reads unknown historical payloads in ascending revision order without rewriting bytes', () => {
    const { db, registry } = setup(':memory:', () => {
      throw new Error('Reads must not request time')
    })
    const rows = [
      { version: 9, payload: ' "fictional historic value" ' },
      { version: 3, payload: '{\n "removedField": 42\n}' },
    ]
    for (const row of rows)
      db.prepare('INSERT INTO revisions VALUES (?, ?, ?, ?, ?)').run(
        'normative',
        'historical-only',
        row.version,
        row.payload,
        '2030-01-01T00:00:00.000Z',
      )
    const before = db.prepare('SELECT * FROM revisions ORDER BY revision').all()
    expect(registry.history('normative', 'historical-only')).toEqual([
      { revision: 3, payload: { removedField: 42 }, updatedAt: '2030-01-01T00:00:00.000Z' },
      { revision: 9, payload: 'fictional historic value', updatedAt: '2030-01-01T00:00:00.000Z' },
    ])
    expect(registry.listNormative()).toEqual([])
    expect(db.prepare('SELECT * FROM revisions ORDER BY revision').all()).toEqual(before)
  })

  it('validates dates and checked-source fields before BEGIN without rolling back caller work', () => {
    const { db, registry } = setup(':memory:', () => {
      throw new Error('Invalid input must not request time')
    })
    db.exec(
      "BEGIN IMMEDIATE; CREATE TABLE caller_marker (value TEXT); INSERT INTO caller_marker VALUES ('fictional')",
    )
    expect(() => registry.saveCrossing({ ...crossing, verifiedAt: 'not a date' }, 0)).toThrow(
      ZodError,
    )
    expect(() => registry.saveNormative({ ...normative, reviewStatus: 'checked' }, 0)).toThrow(
      ZodError,
    )
    expect(db.isTransaction).toBe(true)
    expect(db.prepare('SELECT value FROM caller_marker').get()).toEqual({ value: 'fictional' })
    expect(registry.listCrossings()).toEqual([])
    expect(registry.listNormative()).toEqual([])
    db.exec('ROLLBACK')
  })

  it('rolls back a clock failure and keeps the same connection usable', () => {
    let fail = true
    const failure = new Error('synthetic clock failure')
    const { db, registry } = setup(':memory:', () => {
      if (fail) throw failure
      return '2030-01-01T00:00:00.000Z'
    })
    expect(() => registry.saveNormative(normative, 0)).toThrow(failure)
    expect(db.isTransaction).toBe(false)
    expect(registry.listNormative()).toEqual([])
    expect(registry.history('normative', normative.id)).toEqual([])
    fail = false
    expect(
      registry.saveNormative(
        {
          ...normative,
          reviewStatus: 'checked',
          checkedAt: '2030-01-01',
          reviewer: ' Учебный специалист ',
        },
        0,
      ),
    ).toMatchObject({ revision: 1, reviewer: 'Учебный специалист' })
  })

  it('rejects an invalid current payload instead of silently normalizing or rewriting it', () => {
    const { db, registry } = setup()
    registry.saveCrossing(crossing, 0)
    const payload = '{"fictionalUnknownField":true}'
    db.prepare('UPDATE crossings SET payload_json = ? WHERE key = ?').run(
      payload,
      crossing.referenceId,
    )
    expect(() => registry.listCrossings()).toThrow(ZodError)
    expect(db.prepare('SELECT payload_json FROM crossings').get()).toEqual({
      payload_json: payload,
    })
    expect(registry.history('crossings', crossing.referenceId)).toMatchObject([
      { revision: 1, payload: crossing },
    ])
  })
})
