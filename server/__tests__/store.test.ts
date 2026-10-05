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
import { migrationNotice, RegistryStore, RevisionConflict, SCHEMA_VERSION } from '../store'
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
    const store = new RegistryStore(path)
    try {
      expect(store.saveProject(scheme, 0).revision).toBe(1)
      const changed = { ...scheme, parameters: { ...scheme.parameters, approachSpeedKmh: 65 } }
      expect(store.saveProject(changed, 1).revision).toBe(2)
      expect(store.restoreProject(scheme.id, 1, 2)?.scheme.decisionEvidence).toEqual(
        scheme.decisionEvidence,
      )
      store.saveRecovery(
        {
          sessionId,
          scheme,
          baseRevision: 3,
          detailsDraft: draft,
          placementDraft: null,
          fileName: 'synthetic-v9.json',
          expectedVersion: 0,
        },
        ownerId,
      )
    } finally {
      store.close()
    }
    const reopened = new RegistryStore(path)
    try {
      expect(reopened.schemaVersion()).toBe(13)
      expect(reopened.getProjectRevision(scheme.id, 1)?.scheme.decisionEvidence).toEqual(
        scheme.decisionEvidence,
      )
      expect(reopened.getProject(scheme.id)?.scheme).toEqual(scheme)
      expect(reopened.getRecovery(sessionId)?.detailsDraft).toEqual(draft)
    } finally {
      reopened.close()
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
    const store = new RegistryStore(path)
    try {
      expect(store.saveRecovery(input, ownerId).version).toBe(1)
      expect(store.listProjects()).toEqual([])
      expect(store.listProjectRevisions(scheme.id)).toEqual([])
      expect(store.listRecoveries()).toMatchObject([{ sessionId, referenceId: 'TEST-001' }])
      expect(() => store.saveRecovery(input, ownerId)).toThrow(RevisionConflict)
      expect(store.saveRecovery({ ...input, expectedVersion: 1 }, ownerId).version).toBe(2)
    } finally {
      store.close()
    }
    const reopened = new RegistryStore(path)
    try {
      expect(reopened.getRecovery(sessionId)).toMatchObject({
        scheme,
        detailsDraft,
        version: 2,
      })
      expect(() => reopened.deleteRecovery(sessionId, 1, ownerId)).toThrow(RevisionConflict)
      reopened.deleteRecovery(sessionId, 2, ownerId)
      expect(reopened.getRecovery(sessionId)).toBeNull()
      expect(reopened.listProjects()).toEqual([])
    } finally {
      reopened.close()
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
    const store = new RegistryStore(path, () => '2026-09-26T12:00:00.000Z')
    try {
      expect(store.listNormative()).toHaveLength(4)
      expect(store.listNormative().every((row) => row.reviewStatus === 'needs-review')).toBe(true)
      expect(store.listCrossings()).toEqual([])
      expect(store.saveCrossing(crossing, 0).revision).toBe(1)
      expect(
        store.saveCrossing({ ...crossing, roadOwner: 'Другой учебный владелец' }, 1).revision,
      ).toBe(2)
      expect(() => store.saveCrossing(crossing, 1)).toThrow(RevisionConflict)
      expect(store.history('crossings', 'TEST-001').map((row) => row.revision)).toEqual([1, 2])
      const backupName = await store.createBackup()
      const backupPath = join(directory, 'backups', backupName)
      expect(existsSync(backupPath)).toBe(true)
      const restored = new RegistryStore(backupPath)
      try {
        expect(restored.listCrossings()).toMatchObject([{ referenceId: 'TEST-001', revision: 2 }])
        expect(restored.history('crossings', 'TEST-001')).toHaveLength(2)
      } finally {
        restored.close()
      }
    } finally {
      store.close()
    }
    const reopened = new RegistryStore(path)
    try {
      expect(reopened.listCrossings()).toMatchObject([{ referenceId: 'TEST-001', revision: 2 }])
      expect(reopened.listNormative()).toHaveLength(4)
    } finally {
      reopened.close()
    }
  })

  it('requires date and reviewer to mark a normative entry checked', () => {
    const store = new RegistryStore(':memory:')
    try {
      const entry = store.listNormative()[0]!
      const { revision, updatedAt: _updatedAt, ...draft } = entry
      void _updatedAt
      expect(normativeDraftSchema.safeParse({ ...draft, reviewStatus: 'checked' }).success).toBe(
        false,
      )
      expect(
        store.saveNormative(
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
      store.close()
    }
  })

  it('keeps immutable project revisions, rejects stale saves and restores a previous version', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'tod-project-'))
    directories.push(directory)
    const path = join(directory, 'registry.sqlite')
    const scheme = importSchemeJson(fixture).scheme
    const store = new RegistryStore(path, () => '2026-09-26T12:00:00.000Z')
    try {
      expect(store.listProjects()).toEqual([])
      expect(store.saveProject(scheme, 0).revision).toBe(1)
      expect(store.saveProject(scheme, 1).revision).toBe(1)
      const changed = {
        ...scheme,
        parameters: { ...scheme.parameters, locationText: 'Изменённый учебный участок' },
      }
      expect(store.saveProject(changed, 1).revision).toBe(2)
      expect(() => store.saveProject(scheme, 1)).toThrow(RevisionConflict)
      expect(store.listProjects()).toMatchObject([
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
      expect(store.listProjectRevisions(scheme.id).map((entry) => entry.revision)).toEqual([2, 1])
      expect(store.getProjectRevision(scheme.id, 1)?.scheme).toEqual(scheme)
      expect(store.restoreProject(scheme.id, 1, 2)).toMatchObject({ revision: 3, scheme })
      expect(store.restoreProject(scheme.id, 1, 3)).toMatchObject({ revision: 4, scheme })
      expect(store.getProjectRevision(scheme.id, 2)?.scheme.parameters.locationText).toBe(
        'Изменённый учебный участок',
      )
      expect(store.getProject(scheme.id)?.scheme.source).toMatchObject({ originalJson: fixture })
      const backupName = await store.createBackup()
      const backup = new RegistryStore(join(directory, 'backups', backupName))
      try {
        expect(backup.listProjectRevisions(scheme.id)).toHaveLength(4)
      } finally {
        backup.close()
      }
    } finally {
      store.close()
    }
    const reopened = new RegistryStore(path)
    try {
      expect(reopened.getProject(scheme.id)?.revision).toBe(4)
      expect(reopened.getProject(scheme.id)?.scheme.source).toMatchObject({ originalJson: fixture })
    } finally {
      reopened.close()
    }
  })

  it('stores one copy of an imported source across projects and new revisions', () => {
    const directory = mkdtempSync(join(tmpdir(), 'tod-project-source-'))
    directories.push(directory)
    const path = join(directory, 'registry.sqlite')
    const scheme = importSchemeJson(fixture).scheme
    const other = { ...scheme, id: randomUUID() }
    const store = new RegistryStore(path)
    try {
      store.saveProject(scheme, 0)
      store.saveProject(
        { ...scheme, parameters: { ...scheme.parameters, locationText: 'Правка' } },
        1,
      )
      store.saveProject(other, 0)
      expect(store.getProjectRevision(scheme.id, 1)?.scheme).toEqual(scheme)
      expect(store.getProject(other.id)?.scheme).toEqual(other)
      expect(store.restoreProject(scheme.id, 1, 2)?.scheme).toEqual(scheme)
    } finally {
      store.close()
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
    const reopened = new RegistryStore(path)
    try {
      expect(reopened.getProject(scheme.id)?.scheme.source).toMatchObject({ originalJson: fixture })
    } finally {
      reopened.close()
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
    const store = new RegistryStore(path)
    try {
      expect(store.saveProject(scheme, 0).revision).toBe(1)
    } finally {
      store.close()
    }
    const reopened = new RegistryStore(path)
    try {
      expect(reopened.getProject(scheme.id)?.scheme).toEqual(scheme)
      expect(reopened.getProjectRevision(scheme.id, 1)?.scheme.parameters.workZones.b33).toBeNull()
      expect(reopened.listProjects()).toMatchObject([{ referenceId: 'TEST-NATIVE', revision: 1 }])
    } finally {
      reopened.close()
    }
  })

  it('opens saved v2 revisions as v4 without changing their stored history', () => {
    const directory = mkdtempSync(join(tmpdir(), 'tod-project-v2-'))
    directories.push(directory)
    const path = join(directory, 'registry.sqlite')
    const scheme = importSchemeJson(fixture).scheme
    const previous = schemeV2Schema.parse(oldSnapshot(scheme, 2))
    const initialized = new RegistryStore(path)
    initialized.close()
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

    const store = new RegistryStore(path)
    // Старые версии получают прежнюю версию условной раскладки шаблона.
    const upgraded = { ...scheme, template: { ...scheme.template, projectionVersion: 'draft-1' } }
    try {
      expect(store.getProject(scheme.id)?.scheme).toEqual(upgraded)
      expect(store.getProjectRevision(scheme.id, 1)?.scheme).toEqual(upgraded)
      expect(store.saveProject(schemeSchema.parse(upgraded), 1).revision).toBe(1)
      const edited = {
        ...scheme,
        parameters: { ...scheme.parameters, locationText: 'Новая редакция' },
      }
      expect(store.saveProject(edited, 1).revision).toBe(2)
      expect(store.restoreProject(scheme.id, 1, 2)?.scheme).toEqual(scheme)
    } finally {
      store.close()
    }
    const check = new DatabaseSync(path)
    try {
      const records = check
        .prepare('SELECT revision, scheme_json FROM project_revisions ORDER BY revision')
        .all() as { revision: number; scheme_json: string }[]
      expect(records.map((record) => JSON.parse(record.scheme_json).schemaVersion)).toEqual([
        2, 9, 9,
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
    const initialized = new RegistryStore(path)
    initialized.close()
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

    const store = new RegistryStore(path)
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
      expect(store.getProject(scheme.id)?.scheme).toEqual(upgraded)
      expect(store.getProjectRevision(scheme.id, 1)?.scheme).toEqual(upgraded)
      expect(store.saveProject(schemeSchema.parse(upgraded), 1).revision).toBe(1)
    } finally {
      store.close()
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
    const initialized = new RegistryStore(path)
    initialized.close()
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

    const upgraded = new RegistryStore(path)
    try {
      expect(upgraded.getProjectRevision(scheme.id, 1)?.scheme).toEqual(scheme)
      const changed = { ...scheme, parameters: { ...scheme.parameters, locationText: 'Правка' } }
      expect(upgraded.saveProject(changed, 1).revision).toBe(2)
      expect(upgraded.getProjectRevision(scheme.id, 1)?.scheme).toEqual(scheme)
    } finally {
      upgraded.close()
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
    expect(() => new RegistryStore(path)).toThrow()
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
    const current = new RegistryStore(path)
    current.saveCrossing(crossing, 0)
    current.close()
    const old = new DatabaseSync(path)
    old.exec(
      'DROP TABLE project_recovery; DROP TABLE project_sources; DROP TABLE pu66_verifications; DROP TABLE project_revisions; DROP TABLE project_drafts; PRAGMA user_version = 3;',
    )
    old.close()

    const migrated = new RegistryStore(path)
    try {
      expect(migrated.listCrossings()).toMatchObject([{ referenceId: 'TEST-001', revision: 1 }])
      expect(migrated.listProjects()).toEqual([])
      expect(migrated.saveProject(importSchemeJson(fixture).scheme, 0).revision).toBe(1)
    } finally {
      migrated.close()
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
      const current = new RegistryStore(path)
      current.saveCrossing(crossing, 0)
      expect(current.migratedFrom).toBeNull()
      expect(migrationNotice(current)).toBeNull()
      current.close()
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
      const updated = new RegistryStore(path, () => '2026-10-05T12:00:00.000Z')
      const backup = updated.migrationBackup!
      try {
        expect(updated.migratedFrom).toBe(12)
        expect(backup).toMatch(
          /^registry-before-update-v12-2026-10-05T12-00-00-000Z-[a-f0-9]{8}\.sqlite$/,
        )
        expect(migrationNotice(updated)).toBe(
          `База обновлена: версия 12 → ${SCHEMA_VERSION}. Прежняя база сохранена: ${join(directory, 'backups', backup)}`,
        )
        expect(updated.listCrossings()).toMatchObject([{ referenceId: 'TEST-001' }])
      } finally {
        updated.close()
      }
      const copy = new DatabaseSync(join(directory, 'backups', backup), { readOnly: true })
      try {
        expect(copy.prepare('PRAGMA user_version').get()).toEqual({ user_version: 12 })
        expect(copy.prepare('SELECT key FROM crossings').all()).toEqual([{ key: 'TEST-001' }])
      } finally {
        copy.close()
      }
      const again = new RegistryStore(path)
      try {
        expect(again.migratedFrom).toBeNull()
        expect(again.migrationBackup).toBeNull()
      } finally {
        again.close()
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
      expect(() => new RegistryStore(path)).toThrow()
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
      expect(() => new RegistryStore(path)).toThrow(
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
      new RegistryStore(path).close()
      const plan = await planBackupPrune(join(directory, 'backups'), { keep: 1, maxAgeDays: 1 })
      expect(plan).toEqual({ keep: [], remove: [] })
    })
  })
})
