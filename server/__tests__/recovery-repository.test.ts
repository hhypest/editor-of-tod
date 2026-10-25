import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { importSchemeJson } from '../../src/domain/import'
import { createSchemeDetailsDraft } from '../../src/domain/edit-details'
import type { Scheme } from '../../src/domain/model'
import { MAX_LOCAL_PROJECT_BYTES } from '../../src/domain/local-projects'
import { RECOVERY_LEASE_MS } from '../../src/application/recovery-session'
import { openDatabase } from '../database/connection'
import { migrateDatabase } from '../database/migration-runner'
import { ProjectSourceStore } from '../projects/project-source-store'
import { ProjectRepository } from '../projects/project-repository'
import { RecoveryRepository } from '../recovery/recovery-repository'
import { ProjectTooLarge, RecoveryOwned, RevisionConflict } from '../storage-errors'
import { RecoveryOwned as FacadeRecoveryOwned } from '../store'

const scheme = importSchemeJson(readFileSync('tests/fixtures/manual-v1.json', 'utf8')).scheme
const connections: DatabaseSync[] = [],
  directories: string[] = []
afterEach(() => {
  for (const db of connections.splice(0)) db.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})
const hash = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')
function input(value = scheme) {
  return {
    sessionId: randomUUID(),
    scheme: value,
    expectedVersion: 0,
    baseRevision: null,
    detailsDraft: createSchemeDetailsDraft(value),
    placementDraft: null,
    fileName: 'fictional.json',
  }
}
function reference(value: Scheme): unknown {
  if (value.source.kind !== 'legacy-html-v1') throw new Error('Expected fictional imported source')
  return { ...value, source: { kind: value.source.kind, importedAt: value.source.importedAt } }
}
function sourceHash(value: Scheme) {
  if (value.source.kind !== 'legacy-html-v1') throw new Error('Expected fictional imported source')
  return hash(value.source.originalJson)
}
function setup(path = ':memory:', now = () => '2030-01-01T00:00:00.000Z') {
  const db = openDatabase(path)
  connections.push(db)
  migrateDatabase(db, { path, now })
  const sources = new ProjectSourceStore(db)
  return { db, sources, recovery: new RecoveryRepository(db, sources, now) }
}

describe('RecoveryRepository on its caller-owned connection', () => {
  it('reads empty state without seeding, and keeps the facade error constructor', () => {
    const { db, recovery } = setup()
    expect(FacadeRecoveryOwned).toBe(RecoveryOwned)
    expect(recovery.list()).toEqual([])
    expect(recovery.get(randomUUID())).toBeNull()
    expect(db.prepare('SELECT COUNT(*) AS count FROM normative').get()).toEqual({ count: 0 })
  })

  it('keeps pending fields/version through renew/release and requires claim before another owner can save', () => {
    let now = Date.parse('2030-01-01T00:00:00.000Z')
    const { recovery, db } = setup(':memory:', () => new Date(now).toISOString())
    const ownerId = randomUUID(),
      other = randomUUID(),
      draft = input()
    draft.detailsDraft.parameters.locationText = 'Неприменённое учебное значение'
    const saved = recovery.save({ input: draft, ownerId })
    const command = { input: { ...draft, expectedVersion: 1 }, ownerId: other }
    expect(() => recovery.get(draft.sessionId, {})).toThrow(RecoveryOwned)
    now += RECOVERY_LEASE_MS
    expect(recovery.list()).toMatchObject([{ active: false }])
    expect(() => recovery.save(command)).toThrow(RecoveryOwned)
    expect(
      recovery.claim({ sessionId: draft.sessionId, ownerId: other, expectedVersion: 1 }),
    ).toEqual({ ...saved, version: 2 })
    const before = recovery.get(draft.sessionId)
    recovery.renew({ sessionId: draft.sessionId, ownerId: other })
    recovery.release({ sessionId: draft.sessionId, ownerId }) // Stale release is harmless.
    expect(recovery.get(draft.sessionId)).toEqual(before)
    expect(recovery.list()).toMatchObject([{ active: true }])
    expect(() => recovery.renew({ sessionId: draft.sessionId, ownerId })).toThrow(RecoveryOwned)
    recovery.release({ sessionId: draft.sessionId, ownerId: other })
    expect(() =>
      recovery.save({ ...command, input: { ...draft, expectedVersion: 2 }, ownerId }),
    ).toThrow(RecoveryOwned)
    expect(db.prepare('SELECT COUNT(*) AS count FROM project_revisions').get()).toEqual({
      count: 0,
    })
  })

  it('holds BEGIN IMMEDIATE while resolving a source, preventing an expired copy from being claimed between source and write', () => {
    const directory = mkdtempSync(join(tmpdir(), 'tod-recovery-source-lock-'))
    directories.push(directory)
    const path = join(directory, 'registry.sqlite')
    let now = Date.parse('2030-01-01T00:00:00.000Z')
    const clock = () => new Date(now).toISOString()
    const one = setup(path, clock),
      two = setup(path, clock)
    two.db.exec('PRAGMA busy_timeout = 1') // Deterministic lock probe, only on this test connection.
    const ownerId = randomUUID(),
      other = randomUUID(),
      draft = input()
    one.recovery.save({ input: draft, ownerId })
    now += RECOVERY_LEASE_MS + 1
    let probes = 0
    const atomic = new RecoveryRepository(
      one.db,
      {
        encode: (value) => one.sources.encode(value),
        removeUnreferenced: (payload) => one.sources.removeUnreferenced(payload),
        decode: (payload) => {
          probes++
          expect(one.db.isTransaction).toBe(true)
          expect(() =>
            two.recovery.claim({ sessionId: draft.sessionId, ownerId: other, expectedVersion: 1 }),
          ).toThrow(/database is locked/)
          return one.sources.decode(payload)
        },
      },
      clock,
    )
    const saved = atomic.save({
      input: { ...draft, scheme: reference(scheme), expectedVersion: 1 },
      ownerId,
      sourceSha256: sourceHash(scheme),
    })
    expect(probes).toBe(1)
    expect(saved).toMatchObject({ version: 2, scheme })
    expect(one.db.isTransaction).toBe(false)
    expect(() =>
      two.recovery.claim({ sessionId: draft.sessionId, ownerId: other, expectedVersion: 2 }),
    ).toThrow(RecoveryOwned)
    expect(two.recovery.get(draft.sessionId, { ownerId })).toEqual(saved)
  })

  it.each(['foreign-source', 'new-copy', 'inline-with-reference'])(
    'does not borrow another source or accept an ambiguous transfer: %s',
    (kind) => {
      const { db, recovery } = setup(),
        ownerId = randomUUID(),
        draft = input()
      const first = recovery.save({ input: draft, ownerId })
      const foreign = {
        ...scheme,
        source: { ...scheme.source, originalJson: '{"fictional":"other source"}' },
      } as Scheme
      recovery.save({ input: input(foreign), ownerId })
      const before = db.prepare('SELECT * FROM project_recovery ORDER BY session_id').all()
      expect(() =>
        recovery.save({
          input: {
            ...draft,
            sessionId: kind === 'new-copy' ? randomUUID() : draft.sessionId,
            expectedVersion: kind === 'new-copy' ? 0 : 1,
            scheme: kind === 'inline-with-reference' ? scheme : reference(scheme),
          },
          ownerId,
          sourceSha256: kind === 'foreign-source' ? sourceHash(foreign) : sourceHash(scheme),
        }),
      ).toThrow(RevisionConflict)
      expect(db.prepare('SELECT * FROM project_recovery ORDER BY session_id').all()).toEqual(before)
      expect(recovery.get(draft.sessionId, { ownerId })).toEqual(first)
      expect(db.isTransaction).toBe(false)
    },
  )

  it('rejects stale writes without inserting a new source, and deletes only the last unreferenced source', () => {
    const { db, sources, recovery } = setup(),
      ownerId = randomUUID(),
      draft = input()
    const projects = new ProjectRepository(db, sources, () => '2030-01-01T00:00:00.000Z')
    projects.save(scheme, 0)
    recovery.save({ input: draft, ownerId })
    const other = input({
      ...scheme,
      source: { ...scheme.source, originalJson: '{"fictional":"recovery only"}' },
    } as Scheme)
    recovery.save({ input: other, ownerId })
    expect(() =>
      recovery.save({
        input: {
          ...other,
          scheme: { ...scheme, source: { ...scheme.source, originalJson: 'not inserted' } },
        },
        ownerId,
      }),
    ).toThrow(RevisionConflict)
    expect(db.prepare('SELECT COUNT(*) AS count FROM project_sources').get()).toEqual({ count: 2 })
    expect(() =>
      recovery.delete({ sessionId: other.sessionId, ownerId, expectedVersion: 2 }),
    ).toThrow(RevisionConflict)
    recovery.delete({ sessionId: other.sessionId, ownerId, expectedVersion: 1 })
    recovery.delete({ sessionId: draft.sessionId, ownerId, expectedVersion: 1 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM project_sources').get()).toEqual({ count: 1 })
    expect(projects.getRevision(scheme.id, 1)?.scheme).toEqual(scheme)
  })

  it('checks the full reconstructed UTF-8 payload, even when the SHA transfer fits under 32 MB', () => {
    const { db, recovery } = setup(),
      ownerId = randomUUID()
    const originalJson = JSON.stringify({ fictional: '中'.repeat(1_400_000) })
    const base: Scheme = {
      ...scheme,
      source: { kind: 'legacy-html-v1', importedAt: scheme.createdAt, originalJson },
    }
    const draft = input(base),
      saved = recovery.save({ input: draft, ownerId })
    const large: Scheme = {
      ...base,
      placements: Array.from({ length: 2_000 }, (_, i) => ({
        kind: 'element',
        id: i + 1,
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
    const transfer = { ...draft, scheme: reference(large), expectedVersion: 1 }
    expect(Buffer.byteLength(JSON.stringify(transfer))).toBeLessThan(MAX_LOCAL_PROJECT_BYTES)
    expect(Buffer.byteLength(JSON.stringify({ ...transfer, scheme: large }))).toBeGreaterThan(
      MAX_LOCAL_PROJECT_BYTES,
    )
    const before = db.prepare('SELECT * FROM project_recovery').all()
    expect(() =>
      recovery.save({ input: transfer, ownerId, sourceSha256: hash(originalJson) }),
    ).toThrow(ProjectTooLarge)
    expect(db.prepare('SELECT * FROM project_recovery').all()).toEqual(before)
    expect(recovery.get(draft.sessionId, { ownerId })).toEqual(saved)
    expect(db.isTransaction).toBe(false)
  })
})
