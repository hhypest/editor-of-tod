import { openTestApplication } from './test-application'
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { createUnlinkedScheme } from '../../src/domain/create-scheme'
import { importSchemeJson } from '../../src/domain/import'
import { createSchemeDetailsDraft } from '../../src/domain/edit-details'
import { schemeSchema, schemeV2Schema, schemeV3Schema } from '../../src/domain/model'
import { normativeDraftSchema, type CrossingDraft } from '../../src/domain/registry'
import { migrationNotice } from '../database/migration-notice'
import { RevisionConflict } from '../storage-errors'
import { SCHEMA_VERSION } from '../database/schema-version'
import { planBackupPrune } from '../backup-retention'
import { oldSnapshot } from '../../tests/fixtures/old-version'
import { recordSpeedDecision, recordRegulationDecision } from '../../src/domain/decision-evidence'
import { PROTOTYPE_RULES } from '../../src/domain/normative-parameters'

const directories: string[] = []
const fixture = readFileSync(
  new URL('../../tests/fixtures/manual-v1.json', import.meta.url),
  'utf8',
)
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

const crossing: CrossingDraft = {
  referenceId: 'TEST-001',
  railwayLocation: 'Учебный участок',
  roadName: 'Условная дорога',
  roadOwner: 'Учебный владелец',
  cardReference: 'Вымышленная карточка',
  cardUpdatedAt: '2026-09-26',
  verifiedAt: '',
  notes: 'Без реальных данных',
}

describe('local SQLite registries', () => {
  it('preserves v9 decision evidence in SQLite history, restore and pending recovery after reopening', () => {
    const directory = mkdtempSync(join(tmpdir(), 'tod-decision-evidence-'))
    directories.push(directory)
    const path = join(directory, 'registry.sqlite')
    let scheme = importSchemeJson(fixture).scheme
    scheme.parameters.location = 'out'
    scheme.parameters.speedConditions = { road: 'ordinary', vehicle: 'heavy' }
    scheme.parameters.regulation.mode = 'two'
    scheme = recordSpeedDecision(scheme, PROTOTYPE_RULES, 'Учебные условия потока')
    scheme = recordRegulationDecision(
      scheme,
      PROTOTYPE_RULES,
      'Учебная причина выбора двух регулировщиков',
    )
    const draft = createSchemeDetailsDraft(scheme)
    draft.parameters.speedConditions = { road: 'ordinary', vehicle: 'light' }
    draft.decisionNotes!.speed = 'Неприменённое новое обоснование'
    const sessionId = randomUUID()
    const ownerId = randomUUID()
    const store = openTestApplication(path)
    try {
      expect(store.projects.save(scheme, 0).revision).toBe(1)
      const changed = { ...scheme, parameters: { ...scheme.parameters, approachSpeedKmh: 65 } }
      expect(store.projects.save(changed, 1).revision).toBe(2)
      expect(store.projects.restore(scheme.id, 1, 2)?.scheme.decisionEvidence).toEqual(
        scheme.decisionEvidence,
      )
      store.recovery.save({
        input: {
          sessionId,
          scheme,
          baseRevision: 3,
          detailsDraft: draft,
          placementDraft: null,
          fileName: 'synthetic-v9.json',
          expectedVersion: 0,
        },
        ownerId: ownerId,
      })
    } finally {
      store.runtime.close()
    }
    const reopened = openTestApplication(path)
    try {
      expect(reopened.runtime.schemaVersion()).toBe(13)
      expect(reopened.projects.getRevision(scheme.id, 1)?.scheme.decisionEvidence).toEqual(
        scheme.decisionEvidence,
      )
      expect(reopened.projects.get(scheme.id)?.scheme).toEqual(scheme)
      expect(reopened.recovery.get(sessionId)?.detailsDraft).toEqual(draft)
    } finally {
      reopened.runtime.close()
    }
  })
  it('recovers uncommitted fields without making a project revision and rejects stale recovery writes', () => {
    const directory = mkdtempSync(join(tmpdir(), 'tod-recovery-'))
    directories.push(directory)
    const path = join(directory, 'registry.sqlite')
    const scheme = importSchemeJson(fixture).scheme
    const sessionId = randomUUID()
    const ownerId = randomUUID()
    const detailsDraft = createSchemeDetailsDraft(scheme)
    detailsDraft.parameters.locationText = 'Неприменённое значение'
    const input = {
      sessionId,
      scheme,
      baseRevision: null,
      detailsDraft,
      placementDraft: null,
      fileName: 'учебный.json',
      expectedVersion: 0,
    }
    const store = openTestApplication(path)
    try {
      expect(store.recovery.save({ input: input, ownerId: ownerId }).version).toBe(1)
      expect(store.projects.list()).toEqual([])
      expect(store.projects.listRevisions(scheme.id)).toEqual([])
      expect(store.recovery.list()).toMatchObject([{ sessionId, referenceId: 'TEST-001' }])
      expect(() => store.recovery.save({ input: input, ownerId: ownerId })).toThrow(
        RevisionConflict,
      )
      expect(
        store.recovery.save({ input: { ...input, expectedVersion: 1 }, ownerId: ownerId }).version,
      ).toBe(2)
    } finally {
      store.runtime.close()
    }
    const reopened = openTestApplication(path)
    try {
      expect(reopened.recovery.get(sessionId)).toMatchObject({
        scheme,
        detailsDraft,
        version: 2,
      })
      expect(() =>
        reopened.recovery.delete({ sessionId: sessionId, expectedVersion: 1, ownerId: ownerId }),
      ).toThrow(RevisionConflict)
      reopened.recovery.delete({ sessionId: sessionId, expectedVersion: 2, ownerId: ownerId })
      expect(reopened.recovery.get(sessionId)).toBeNull()
      expect(reopened.projects.list()).toEqual([])
    } finally {
      reopened.runtime.close()
    }
    const raw = new DatabaseSync(path)
    try {
      expect(raw.prepare('SELECT COUNT(*) AS count FROM project_sources').get()).toMatchObject({
        count: 0,
      })
    } finally {
      raw.close()
    }
  })

  it('keeps crossing revisions, rejects stale edits, and persists only in a local file', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'tod-registry-'))
    directories.push(directory)
    const path = join(directory, 'registry.sqlite')
    const store = openTestApplication(path, () => '2026-09-26T12:00:00.000Z')
    try {
      expect(store.legacy.listNormative()).toHaveLength(4)
      expect(store.legacy.listNormative().every((row) => row.reviewStatus === 'needs-review')).toBe(
        true,
      )
      expect(store.legacy.listCrossings()).toEqual([])
      expect(store.legacy.saveCrossing(crossing, 0).revision).toBe(1)
      expect(
        store.legacy.saveCrossing({ ...crossing, roadOwner: 'Другой учебный владелец' }, 1)
          .revision,
      ).toBe(2)
      expect(() => store.legacy.saveCrossing(crossing, 1)).toThrow(RevisionConflict)
      expect(store.legacy.history('crossings', 'TEST-001').map((row) => row.revision)).toEqual([
        1, 2,
      ])
      const backupName = await store.runtime.http.createBackup()
      const backupPath = join(directory, 'backups', backupName)
      expect(existsSync(backupPath)).toBe(true)
      const restored = openTestApplication(backupPath)
      try {
        expect(restored.legacy.listCrossings()).toMatchObject([
          { referenceId: 'TEST-001', revision: 2 },
        ])
        expect(restored.legacy.history('crossings', 'TEST-001')).toHaveLength(2)
      } finally {
        restored.runtime.close()
      }
    } finally {
      store.runtime.close()
    }
    const reopened = openTestApplication(path)
    try {
      expect(reopened.legacy.listCrossings()).toMatchObject([
        { referenceId: 'TEST-001', revision: 2 },
      ])
      expect(reopened.legacy.listNormative()).toHaveLength(4)
    } finally {
      reopened.runtime.close()
    }
  })

  it('requires date and reviewer to mark a normative entry checked', () => {
    const store = openTestApplication(':memory:')
    try {
      const entry = store.legacy.listNormative()[0]!
      const { revision, updatedAt: _updatedAt, ...draft } = entry
      void _updatedAt
      expect(normativeDraftSchema.safeParse({ ...draft, reviewStatus: 'checked' }).success).toBe(
        false,
      )
      expect(
        store.legacy.saveNormative(
          {
            ...draft,
            reviewStatus: 'checked',
            checkedAt: '2026-09-26',
            reviewer: 'Тестовый специалист',
          },
          revision,
        ).revision,
      ).toBe(2)
    } finally {
      store.runtime.close()
    }
  })

  it('keeps immutable project revisions, rejects stale saves and restores a previous version', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'tod-project-'))
    directories.push(directory)
    const path = join(directory, 'registry.sqlite')
    const scheme = importSchemeJson(fixture).scheme
    const store = openTestApplication(path, () => '2026-09-26T12:00:00.000Z')
    try {
      expect(store.projects.list()).toEqual([])
      expect(store.projects.save(scheme, 0).revision).toBe(1)
      expect(store.projects.save(scheme, 1).revision).toBe(1)
      const changed = {
        ...scheme,
        parameters: { ...scheme.parameters, locationText: 'Изменённый учебный участок' },
      }
      expect(store.projects.save(changed, 1).revision).toBe(2)
      expect(() => store.projects.save(scheme, 1)).toThrow(RevisionConflict)
      expect(store.projects.list()).toMatchObject([
        {
          id: scheme.id,
          referenceId: 'TEST-001',
          revision: 2,
          locationText: 'Изменённый учебный участок',
          // Сведения для узнавания проекта берутся из последней редакции.
          directionLeft: 'к станции А',
          directionRight: 'к станции Б',
          crossingLocation: '',
          roadName: '',
        },
      ])
      expect(store.projects.listRevisions(scheme.id).map((entry) => entry.revision)).toEqual([2, 1])
      expect(store.projects.getRevision(scheme.id, 1)?.scheme).toEqual(scheme)
      expect(store.projects.restore(scheme.id, 1, 2)).toMatchObject({ revision: 3, scheme })
      expect(store.projects.restore(scheme.id, 1, 3)).toMatchObject({ revision: 4, scheme })
      expect(store.projects.getRevision(scheme.id, 2)?.scheme.parameters.locationText).toBe(
        'Изменённый учебный участок',
      )
      expect(store.projects.get(scheme.id)?.scheme.source).toMatchObject({ originalJson: fixture })
      const backupName = await store.runtime.http.createBackup()
      const backup = openTestApplication(join(directory, 'backups', backupName))
      try {
        expect(backup.projects.listRevisions(scheme.id)).toHaveLength(4)
      } finally {
        backup.runtime.close()
      }
    } finally {
      store.runtime.close()
    }
    const reopened = openTestApplication(path)
    try {
      expect(reopened.projects.get(scheme.id)?.revision).toBe(4)
      expect(reopened.projects.get(scheme.id)?.scheme.source).toMatchObject({
        originalJson: fixture,
      })
    } finally {
      reopened.runtime.close()
    }
  })

  it('stores one copy of an imported source across projects and new revisions', () => {
    const directory = mkdtempSync(join(tmpdir(), 'tod-project-source-'))
    directories.push(directory)
    const path = join(directory, 'registry.sqlite')
    const scheme = importSchemeJson(fixture).scheme
    const other = { ...scheme, id: randomUUID() }
    const store = openTestApplication(path)
    try {
      store.projects.save(scheme, 0)
      store.projects.save(
        { ...scheme, parameters: { ...scheme.parameters, locationText: 'Правка' } },
        1,
      )
      store.projects.save(other, 0)
      expect(store.projects.getRevision(scheme.id, 1)?.scheme).toEqual(scheme)
      expect(store.projects.get(other.id)?.scheme).toEqual(other)
      expect(store.projects.restore(scheme.id, 1, 2)?.scheme).toEqual(scheme)
    } finally {
      store.runtime.close()
    }
    const raw = new DatabaseSync(path)
    try {
      const sources = raw.prepare('SELECT sha256, original_json FROM project_sources').all() as {
        sha256: string
        original_json: string
      }[]
      expect(sources).toHaveLength(1)
      expect(sources[0]?.original_json).toBe(fixture)
      const rows = raw.prepare('SELECT scheme_json FROM project_revisions').all() as {
        scheme_json: string
      }[]
      expect(rows).toHaveLength(4)
      for (const row of rows) {
        const source = JSON.parse(row.scheme_json).source
        expect(source).toEqual({
          kind: 'legacy-html-v1',
          importedAt: scheme.source.kind === 'legacy-html-v1' ? scheme.source.importedAt : '',
          originalJsonSha256: sources[0]?.sha256,
        })
        expect(row.scheme_json).not.toContain(fixture)
      }
    } finally {
      raw.close()
    }
    const reopened = openTestApplication(path)
    try {
      expect(reopened.projects.get(scheme.id)?.scheme.source).toMatchObject({
        originalJson: fixture,
      })
    } finally {
      reopened.runtime.close()
    }
  })

  it('reopens native B.34 projects without inventing inactive B.33 measurements', () => {
    const directory = mkdtempSync(join(tmpdir(), 'tod-native-'))
    directories.push(directory)
    const path = join(directory, 'registry.sqlite')
    const scheme = createUnlinkedScheme({
      referenceId: 'TEST-NATIVE',
      locationText: 'Учебный участок',
      directionLeft: '',
      directionRight: '',
      frontMetres: '18',
      taperMetres: '8',
      bufferMetres: '10',
      speedStagesKmh: ['70', '50', '40'],
      location: 'out',
      approachSpeedKmh: '90',
      yellowTemporarySigns: false,
    })
    const store = openTestApplication(path)
    try {
      expect(store.projects.save(scheme, 0).revision).toBe(1)
    } finally {
      store.runtime.close()
    }
    const reopened = openTestApplication(path)
    try {
      expect(reopened.projects.get(scheme.id)?.scheme).toEqual(scheme)
      expect(
        reopened.projects.getRevision(scheme.id, 1)?.scheme.parameters.workZones.b33,
      ).toBeNull()
      expect(reopened.projects.list()).toMatchObject([{ referenceId: 'TEST-NATIVE', revision: 1 }])
    } finally {
      reopened.runtime.close()
    }
  })

  it('opens saved v2 revisions as v4 without changing their stored history', () => {
    const directory = mkdtempSync(join(tmpdir(), 'tod-project-v2-'))
    directories.push(directory)
    const path = join(directory, 'registry.sqlite')
    const scheme = importSchemeJson(fixture).scheme
    const previous = schemeV2Schema.parse(oldSnapshot(scheme, 2))
    const initialized = openTestApplication(path)
    initialized.runtime.close()
    const raw = new DatabaseSync(path)
    const savedAt = '2026-09-26T12:00:00.000Z'
    raw
      .prepare(
        'INSERT INTO project_drafts (id, revision, scheme_json, reference_id, location_text, template_code, updated_at) VALUES (?, 1, ?, ?, ?, ?, ?)',
      )
      .run(
        scheme.id,
        JSON.stringify(previous),
        scheme.crossing.referenceId,
        scheme.parameters.locationText,
        scheme.template.code,
        savedAt,
      )
    raw
      .prepare(
        'INSERT INTO project_revisions (id, revision, scheme_json, updated_at) VALUES (?, 1, ?, ?)',
      )
      .run(scheme.id, JSON.stringify(previous), savedAt)
    raw.close()

    const store = openTestApplication(path)
    // Старые версии получают прежнюю версию условной раскладки шаблона.
    const upgraded = { ...scheme, template: { ...scheme.template, projectionVersion: 'draft-1' } }
    try {
      expect(store.projects.get(scheme.id)?.scheme).toEqual(upgraded)
      expect(store.projects.getRevision(scheme.id, 1)?.scheme).toEqual(upgraded)
      // Сохранение без правок записывает снимок в текущем формате (редакция 2), повторное — нет.
      expect(store.projects.save(schemeSchema.parse(upgraded), 1).revision).toBe(2)
      expect(store.projects.get(scheme.id)?.storedSchemaVersion).toBe(12)
      expect(store.projects.save(schemeSchema.parse(upgraded), 2).revision).toBe(2)
      const edited = {
        ...scheme,
        parameters: { ...scheme.parameters, locationText: 'Новая редакция' },
      }
      expect(store.projects.save(edited, 2).revision).toBe(3)
      expect(store.projects.restore(scheme.id, 1, 3)?.scheme).toEqual(scheme)
    } finally {
      store.runtime.close()
    }
    const check = new DatabaseSync(path)
    try {
      const records = check
        .prepare('SELECT revision, scheme_json FROM project_revisions ORDER BY revision')
        .all() as { revision: number; scheme_json: string }[]
      expect(records.map((record) => JSON.parse(record.scheme_json).schemaVersion)).toEqual([
        2, 12, 12, 12,
      ])
      expect(JSON.parse(records[0]!.scheme_json)).toEqual(previous)
    } finally {
      check.close()
    }
  })

  it('reads an existing native v3 SQLite draft without rewriting its snapshot', () => {
    const directory = mkdtempSync(join(tmpdir(), 'tod-project-v3-'))
    directories.push(directory)
    const path = join(directory, 'registry.sqlite')
    const scheme = createUnlinkedScheme({
      referenceId: 'TEST-PREVIOUS',
      locationText: 'Условный участок',
      directionLeft: '',
      directionRight: '',
      frontMetres: '18',
      taperMetres: '8',
      bufferMetres: '10',
      speedStagesKmh: ['70', '50', '40'],
      location: 'out',
      approachSpeedKmh: '90',
      yellowTemporarySigns: false,
    })
    const old = schemeV3Schema.parse(oldSnapshot(scheme, 3))
    const initialized = openTestApplication(path)
    initialized.runtime.close()
    const raw = new DatabaseSync(path)
    const savedAt = '2026-09-26T12:00:00.000Z'
    raw
      .prepare(
        'INSERT INTO project_drafts (id, revision, scheme_json, reference_id, location_text, template_code, updated_at) VALUES (?, 1, ?, ?, ?, ?, ?)',
      )
      .run(scheme.id, JSON.stringify(old), 'TEST-PREVIOUS', 'Условный участок', 'b34', savedAt)
    raw
      .prepare(
        'INSERT INTO project_revisions (id, revision, scheme_json, updated_at) VALUES (?, 1, ?, ?)',
      )
      .run(scheme.id, JSON.stringify(old), savedAt)
    raw.close()

    const store = openTestApplication(path)
    // Старые версии получают прежнюю версию условной раскладки шаблона; местоположения и
    // скорости на подходе в v3 не было.
    const upgraded = {
      ...scheme,
      template: { ...scheme.template, projectionVersion: 'draft-1' },
      parameters: {
        ...scheme.parameters,
        location: 'auto',
        approachSpeedKmh: 60,
        signSize: 'auto',
      },
    }
    try {
      expect(store.projects.get(scheme.id)?.scheme).toEqual(upgraded)
      expect(store.projects.getRevision(scheme.id, 1)?.scheme).toEqual(upgraded)
      // Без правок снимок переписывается в текущий формат новой редакцией; первая не меняется.
      expect(store.projects.save(schemeSchema.parse(upgraded), 1).revision).toBe(2)
    } finally {
      store.runtime.close()
    }
    const check = new DatabaseSync(path)
    try {
      const row = check
        .prepare('SELECT scheme_json FROM project_revisions WHERE id = ? AND revision = 1')
        .get(scheme.id) as { scheme_json: string }
      expect(JSON.parse(row.scheme_json)).toEqual(old)
    } finally {
      check.close()
    }
  })

  it('opens v6 project history without rewriting old snapshots during the v8 upgrade', () => {
    const directory = mkdtempSync(join(tmpdir(), 'tod-v6-project-'))
    directories.push(directory)
    const path = join(directory, 'registry.sqlite')
    const scheme = importSchemeJson(fixture).scheme
    const initialized = openTestApplication(path)
    initialized.runtime.close()
    const raw = new DatabaseSync(path)
    const oldPayload = JSON.stringify(scheme)
    raw.exec('DROP TABLE project_recovery; DROP TABLE project_sources; PRAGMA user_version = 6;')
    raw
      .prepare('INSERT INTO project_drafts VALUES (?, 1, ?, ?, ?, ?, ?)')
      .run(
        scheme.id,
        oldPayload,
        scheme.crossing.referenceId,
        scheme.parameters.locationText,
        scheme.template.code,
        '2026-09-26T12:00:00Z',
      )
    raw
      .prepare('INSERT INTO project_revisions VALUES (?, 1, ?, ?)')
      .run(scheme.id, oldPayload, '2026-09-26T12:00:00Z')
    raw.close()

    const upgraded = openTestApplication(path)
    try {
      expect(upgraded.projects.getRevision(scheme.id, 1)?.scheme).toEqual(scheme)
      const changed = { ...scheme, parameters: { ...scheme.parameters, locationText: 'Правка' } }
      expect(upgraded.projects.save(changed, 1).revision).toBe(2)
      expect(upgraded.projects.getRevision(scheme.id, 1)?.scheme).toEqual(scheme)
    } finally {
      upgraded.runtime.close()
    }
    const check = new DatabaseSync(path)
    try {
      expect(check.prepare('PRAGMA user_version').get()).toEqual({ user_version: 13 })
      const rows = check
        .prepare('SELECT scheme_json FROM project_revisions ORDER BY revision')
        .all() as { scheme_json: string }[]
      expect(rows[0]?.scheme_json).toBe(oldPayload)
      expect(JSON.parse(rows[1]!.scheme_json).source).toHaveProperty('originalJsonSha256')
    } finally {
      check.close()
    }
  })

  it('rolls back a failing migration and allows reopening the SQLite file', () => {
    const directory = mkdtempSync(join(tmpdir(), 'tod-broken-migration-'))
    directories.push(directory)
    const path = join(directory, 'registry.sqlite')
    const raw = new DatabaseSync(path)
    raw.exec('PRAGMA user_version = 5')
    raw.close()
    expect(() => openTestApplication(path)).toThrow()
    const reopened = new DatabaseSync(path)
    try {
      expect(reopened.prepare('PRAGMA user_version').get()).toEqual({ user_version: 5 })
      expect(
        reopened
          .prepare("SELECT name FROM sqlite_master WHERE name = 'sign_catalog_batches'")
          .get(),
      ).toBeUndefined()
    } finally {
      reopened.close()
    }
  })

  it('migrates a version 3 database without losing the existing manual registry', () => {
    const directory = mkdtempSync(join(tmpdir(), 'tod-v3-upgrade-'))
    directories.push(directory)
    const path = join(directory, 'registry.sqlite')
    const current = openTestApplication(path)
    current.legacy.saveCrossing(crossing, 0)
    current.runtime.close()
    const old = new DatabaseSync(path)
    old.exec(
      'DROP TABLE project_recovery; DROP TABLE project_sources; DROP TABLE pu66_verifications; DROP TABLE project_revisions; DROP TABLE project_drafts; PRAGMA user_version = 3;',
    )
    old.close()

    const migrated = openTestApplication(path)
    try {
      expect(migrated.legacy.listCrossings()).toMatchObject([
        { referenceId: 'TEST-001', revision: 1 },
      ])
      expect(migrated.projects.list()).toEqual([])
      expect(migrated.projects.save(importSchemeJson(fixture).scheme, 0).revision).toBe(1)
    } finally {
      migrated.runtime.close()
    }
    const database = new DatabaseSync(path)
    expect(database.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 13 })
    database.close()
  })

  describe('backup before a schema update', () => {
    function oldDatabase(name: string) {
      const directory = mkdtempSync(join(tmpdir(), name))
      directories.push(directory)
      const path = join(directory, 'registry.sqlite')
      const current = openTestApplication(path)
      current.legacy.saveCrossing(crossing, 0)
      expect(current.runtime.migratedFrom).toBeNull()
      expect(migrationNotice(current.runtime)).toBeNull()
      current.runtime.close()
      expect(existsSync(join(directory, 'backups'))).toBe(false)
      const old = new DatabaseSync(path)
      old.exec(
        'ALTER TABLE project_recovery DROP COLUMN owner_until; ALTER TABLE project_recovery DROP COLUMN owner_id; PRAGMA user_version = 12;',
      )
      old.close()
      return { directory, path }
    }

    it('keeps the previous file, reports it and does not repeat on the next start', () => {
      const { directory, path } = oldDatabase('tod-backup-update-')
      const updated = openTestApplication(path, () => '2026-10-05T12:00:00.000Z')
      const backup = updated.runtime.migrationBackup!
      try {
        expect(updated.runtime.migratedFrom).toBe(12)
        expect(backup).toMatch(
          /^registry-before-update-v12-2026-10-05T12-00-00-000Z-[a-f0-9]{8}\.sqlite$/,
        )
        expect(migrationNotice(updated.runtime)).toBe(
          `База обновлена: версия 12 → ${SCHEMA_VERSION}. Прежняя база сохранена: ${join(directory, 'backups', backup)}`,
        )
        expect(updated.legacy.listCrossings()).toMatchObject([{ referenceId: 'TEST-001' }])
      } finally {
        updated.runtime.close()
      }
      const copy = new DatabaseSync(join(directory, 'backups', backup), { readOnly: true })
      try {
        expect(copy.prepare('PRAGMA user_version').get()).toEqual({ user_version: 12 })
        expect(copy.prepare('SELECT key FROM crossings').all()).toEqual([{ key: 'TEST-001' }])
      } finally {
        copy.close()
      }
      const again = openTestApplication(path)
      try {
        expect(again.runtime.migratedFrom).toBeNull()
        expect(again.runtime.migrationBackup).toBeNull()
      } finally {
        again.runtime.close()
      }
      expect(readdirSync(join(directory, 'backups'))).toEqual([backup])
    })

    it('leaves the copy in place when the update itself fails', () => {
      const directory = mkdtempSync(join(tmpdir(), 'tod-backup-failed-update-'))
      directories.push(directory)
      const path = join(directory, 'registry.sqlite')
      const raw = new DatabaseSync(path)
      raw.exec('CREATE TABLE crossings (key TEXT PRIMARY KEY); PRAGMA user_version = 5;')
      raw.prepare('INSERT INTO crossings VALUES (?)').run('TEST-KEPT')
      raw.close()
      expect(() => openTestApplication(path)).toThrow()
      const [backup] = readdirSync(join(directory, 'backups'))
      expect(backup).toMatch(/^registry-before-update-v5-/)
      const copy = new DatabaseSync(join(directory, 'backups', backup!), { readOnly: true })
      try {
        expect(copy.prepare('SELECT key FROM crossings').all()).toEqual([{ key: 'TEST-KEPT' }])
      } finally {
        copy.close()
      }
    })

    it('does not touch the database when the copy cannot be written', () => {
      const { directory, path } = oldDatabase('tod-backup-refused-')
      writeFileSync(join(directory, 'backups'), 'не каталог')
      expect(() => openTestApplication(path)).toThrow(
        /Не удалось сохранить копию базы перед обновлением.*База не изменена/s,
      )
      const untouched = new DatabaseSync(path, { readOnly: true })
      try {
        expect(untouched.prepare('PRAGMA user_version').get()).toEqual({ user_version: 12 })
      } finally {
        untouched.close()
      }
    })

    it('is not picked up by automatic pruning of manual backups', async () => {
      const { directory, path } = oldDatabase('tod-backup-prune-')
      openTestApplication(path).runtime.close()
      const plan = await planBackupPrune(join(directory, 'backups'), { keep: 1, maxAgeDays: 1 })
      expect(plan).toEqual({ keep: [], remove: [] })
    })
  })
})
