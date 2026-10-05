import { closeSync, constants, existsSync, mkdirSync, openSync, chmodSync, rmSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { RECOVERY_LEASE_MS, recoveryIsActive } from '../src/application/recovery-session.ts'
import { parseStoredScheme, schemeSchema, type Scheme } from '../src/domain/model.ts'
import {
  MAX_LOCAL_PROJECT_BYTES,
  type ProjectRecord,
  type ProjectRevision,
  type ProjectSummary,
} from '../src/domain/local-projects.ts'
import {
  recoveryRecordSchema,
  recoverySummarySchema,
  type RecoveryRecord,
  type RecoverySummary,
  type RecoveryWrite,
} from '../src/domain/recovery.ts'
import {
  crossingDraftSchema,
  normativeDraftSchema,
  type CrossingDraft,
  type CrossingRecord,
  type NormativeDraft,
  type NormativeRecord,
} from '../src/domain/registry.ts'
import {
  localCalendarDate,
  pu66VerificationWriteSchema,
  type Pu66Verification,
  type Pu66VerificationWrite,
} from '../src/domain/pu66-review.ts'
import {
  type Pu66Card,
  type Pu66Import,
  localCardSummary,
  normativeFields,
  schemeFields,
} from './pu66.ts'
import { type SignImport } from './signs.ts'
import {
  pu66LifecycleWriteSchema,
  type Pu66LifecycleWrite,
  type Pu66Status,
  type Pu66ImportRestore,
} from '../src/domain/pu66-lifecycle.ts'
import {
  documentMetaSchema,
  type DocumentMeta,
  type DocumentRecord,
} from '../src/domain/normative-documents.ts'
import type { ParameterConfirmation } from '../src/domain/normative-parameters.ts'

export type SignCatalogSource = {
  documentCode: string
  edition: string
  pdfSha256: string | null
  /** Документ локальной библиотеки, если архив сверен с прикреплённым PDF. */
  documentId?: number | null
}

export type SignCatalogPlan = {
  added: number
  /** Изменённые изображения и знаки, у которых сменился только источник. */
  updated: number
  unchanged: number
  retired: number
  /** Из `updated`: изображение то же, изменилась только редакция источника. */
  relabelled: number
  addedCodes: string[]
  changedCodes: string[]
  retiredCodes: string[]
}

export class DocumentInUse extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DocumentInUse'
  }
}

const unspecifiedSignSource: SignCatalogSource = {
  documentCode: 'Источник не указан',
  edition: 'не указана',
  pdfSha256: null,
}

type RegistryKind = 'crossings' | 'normative'
type StoredRow = { key: string; revision: number; payload_json: string; updated_at: string }

export class RevisionConflict extends Error {
  constructor() {
    super('Запись изменилась после открытия. Обновите реестр и повторите правку.')
  }
}

export class RecoveryOwned extends Error {
  constructor() {
    super('Копия открыта в другом окне. Закройте его или дождитесь освобождения копии.')
  }
}

export class InvalidPu66Lifecycle extends Error {}

export class ProjectTooLarge extends Error {
  constructor() {
    super('Черновик больше 32 МБ. Скачайте JSON-копию проекта.')
  }
}

export class AmbiguousPu66Key extends Error {
  constructor() {
    super(
      'Ключ станционной карточки ПУ-66 устарел: на станции несколько карточек с этой привязкой. Привяжите проект к карточке заново.',
    )
  }
}

/** Станционный ключ до версии 9 («ст.<станция>:<км>:<пк>») не содержал номера карточки. */
const legacyStationKey = /^ст\.[^:]*:[^:]+:[^:]+$/

export class InvalidPu66Verification extends Error {
  constructor() {
    super('Дата сверки ПУ-66 не может быть в будущем.')
  }
}

const initialNormativeEntries: NormativeDraft[] = [
  {
    id: 'odm-218-6-019-2016-b33',
    documentCode: 'ОДМ 218.6.019-2016',
    edition: '2016',
    clause: 'Приложение Б, рисунок Б.33, с. 100',
    description:
      'Пример схемы для двухполосной дороги при краткосрочных работах; подпись говорит о зоне более 30 м, рисунок содержит обозначение min 30.',
    application:
      'Правило проекта для длины от 30 м. Случай ровно 30 м требует предметной сверки из-за расхождения подписи и размерного обозначения.',
    sourceUrl:
      'https://rosavtodor.gov.ru/about/upravlenie-fda/upravlenie-nauchno-tekhnicheskikh-issledovaniy--i-informatsionnykh-tekhnologiy/tekhnicheskoe-regulirovanie/otraslevye-dorozhnye-metodicheskie-dokumenty/14520',
    reviewStatus: 'needs-review',
    checkedAt: '',
    reviewer: '',
  },
  {
    id: 'odm-218-6-019-2016-b34',
    documentCode: 'ОДМ 218.6.019-2016',
    edition: '2016',
    clause: 'Приложение Б, рисунок Б.34, с. 101',
    description:
      'Пример схемы для двухполосной дороги при краткосрочных работах; подпись говорит о зоне менее 30 м, рисунок содержит обозначение max 30.',
    application:
      'Правило проекта для длины менее 30 м. Условия регулирования движения по интенсивности и видимости следует сверять отдельно.',
    sourceUrl:
      'https://rosavtodor.gov.ru/about/upravlenie-fda/upravlenie-nauchno-tekhnicheskikh-issledovaniy--i-informatsionnykh-tekhnologiy/tekhnicheskoe-regulirovanie/otraslevye-dorozhnye-metodicheskie-dokumenty/14520',
    reviewStatus: 'needs-review',
    checkedAt: '',
    reviewer: '',
  },
  {
    id: 'gost-r-52289-2019',
    documentCode: 'ГОСТ Р 52289-2019',
    edition: '2019; изменения № 1 и № 2 подлежат сверке',
    clause: 'Раздел 5, в том числе 5.1.19 и 5.2.27',
    description:
      'Правила применения технических средств организации дорожного движения; конкретные параметры здесь пока не внесены.',
    application: 'Проверить действующую редакцию и точные пункты перед автоматизацией.',
    sourceUrl: 'https://protect.gost.ru/gost/details/94160176-3252-4e7d-8534-2d172e6aa0de',
    reviewStatus: 'needs-review',
    checkedAt: '',
    reviewer: '',
  },
  {
    id: 'gost-r-52290-2024',
    documentCode: 'ГОСТ Р 52290-2024',
    edition: '2024',
    clause: 'Группы и технические требования к знакам',
    description:
      'Источник для будущего каталога знаков; изображения и полный текст в приложение не включены.',
    application: 'Проверить применимые пункты и права на графику перед публикацией каталога.',
    sourceUrl: 'https://protect.gost.ru/gost/details/39b75217-29bd-492b-94f4-c0dccb72b299',
    reviewStatus: 'needs-review',
    checkedAt: '',
    reviewer: '',
  },
]

/**
 * Поле последней редакции проекта для списка «Мои проекты»: по нему составитель узнаёт
 * проект (место по ПУ-66, дорога, направления, описание работ). Не строка — пустая строка.
 */
function summaryText(path: string): string {
  return `CASE WHEN json_type(scheme_json, '${path}') = 'text'
    THEN substr(json_extract(scheme_json, '${path}'), 1, 500) ELSE '' END`
}

/** Текущая версия схемы локальной базы (`PRAGMA user_version`). */
export const SCHEMA_VERSION = 13

/** Сообщение для окна программы после обновления схемы базы; `null`, если обновления не было. */
export function migrationNotice(store: RegistryStore): string | null {
  if (store.migratedFrom === null) return null
  const versions = `База обновлена: версия ${store.migratedFrom} → ${SCHEMA_VERSION}.`
  return store.migrationBackup
    ? `${versions} Прежняя база сохранена: ${join(store.backupDirectory, store.migrationBackup)}`
    : versions
}

export class RegistryStore {
  private readonly db: DatabaseSync
  readonly path: string
  private readonly now: () => string
  /** Версия схемы, с которой база обновлена при этом открытии; `null` — обновления не было. */
  readonly migratedFrom: number | null = null
  /** Имя копии в `backupDirectory`, снятой перед обновлением схемы; `null` — копия не создавалась. */
  readonly migrationBackup: string | null = null

  constructor(path: string, now: () => string = () => new Date().toISOString()) {
    this.path = path
    this.now = now
    if (path !== ':memory:') {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
      if (!existsSync(path))
        closeSync(openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR, 0o600))
      if (process.platform !== 'win32') chmodSync(path, 0o600)
    }
    this.db = new DatabaseSync(path, { allowExtension: false, defensive: true, timeout: 3_000 })
    try {
      this.db.exec('PRAGMA foreign_keys = ON')
      const version = (this.db.prepare('PRAGMA user_version').get() as { user_version: number })
        .user_version
      if (!Number.isInteger(version) || version < 0 || version > SCHEMA_VERSION) {
        throw new Error(`Неизвестная версия локальной базы: ${version}. Файл не изменён.`)
      }
      this.migratedFrom = version > 0 && version < SCHEMA_VERSION ? version : null
      if (this.migratedFrom !== null && path !== ':memory:')
        this.migrationBackup = this.backupBeforeMigration(version)
      if (version === 0) {
        this.db.exec(`
        BEGIN;
        CREATE TABLE crossings (
          key TEXT PRIMARY KEY,
          revision INTEGER NOT NULL CHECK (revision > 0),
          payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
          updated_at TEXT NOT NULL
        );
        CREATE TABLE normative (
          key TEXT PRIMARY KEY,
          revision INTEGER NOT NULL CHECK (revision > 0),
          payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
          updated_at TEXT NOT NULL
        );
        CREATE TABLE revisions (
          kind TEXT NOT NULL CHECK (kind IN ('crossings', 'normative')),
          key TEXT NOT NULL,
          revision INTEGER NOT NULL,
          payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
          updated_at TEXT NOT NULL,
          PRIMARY KEY (kind, key, revision)
        );
        PRAGMA user_version = 1;
        COMMIT;
      `)
      }
      if (version < 2) {
        this.db.exec(`
        BEGIN;
        CREATE TABLE pu66_sources (
          sha256 TEXT PRIMARY KEY,
          original_name TEXT NOT NULL,
          workbook BLOB NOT NULL
        );
        CREATE TABLE pu66_cards (
          key TEXT PRIMARY KEY,
          revision INTEGER NOT NULL,
          payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
          source_sha256 TEXT NOT NULL REFERENCES pu66_sources(sha256),
          updated_at TEXT NOT NULL
        );
        CREATE TABLE pu66_revisions (
          key TEXT NOT NULL,
          revision INTEGER NOT NULL,
          payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
          source_sha256 TEXT NOT NULL REFERENCES pu66_sources(sha256),
          updated_at TEXT NOT NULL,
          PRIMARY KEY (key, revision)
        );
        CREATE TABLE signs (
          code TEXT PRIMARY KEY,
          numbered_png BLOB NOT NULL,
          plain_png BLOB NOT NULL,
          numbered_sha256 TEXT NOT NULL,
          plain_sha256 TEXT NOT NULL,
          zip_sha256 TEXT NOT NULL,
          width INTEGER NOT NULL,
          height INTEGER NOT NULL,
          revision INTEGER NOT NULL,
          updated_at TEXT NOT NULL
        );
        PRAGMA user_version = 3;
        COMMIT;
      `)
      }
      if (version === 2) {
        // A failed VACUUM can be retried on the next launch without losing the PNGs.
        const columns = this.db.prepare('PRAGMA table_info(signs)').all() as { name: string }[]
        if (columns.some((column) => column.name === 'plain_svg')) {
          this.db.exec('PRAGMA secure_delete = ON')
          this.db.exec('BEGIN IMMEDIATE')
          try {
            this.db.exec('ALTER TABLE signs DROP COLUMN plain_svg')
            this.db.exec('COMMIT')
          } catch (error) {
            this.db.exec('ROLLBACK')
            throw error
          }
        }
        // Rebuild the file so removed vector data is not left in unused SQLite pages.
        this.db.exec('VACUUM')
        this.db.exec('PRAGMA user_version = 3')
      }
      if (version < 4) {
        this.db.exec(`
        BEGIN;
        CREATE TABLE project_drafts (
          id TEXT PRIMARY KEY,
          revision INTEGER NOT NULL CHECK (revision > 0),
          scheme_json TEXT NOT NULL CHECK (json_valid(scheme_json)),
          reference_id TEXT NOT NULL,
          location_text TEXT NOT NULL,
          template_code TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE project_revisions (
          id TEXT NOT NULL,
          revision INTEGER NOT NULL CHECK (revision > 0),
          scheme_json TEXT NOT NULL CHECK (json_valid(scheme_json)),
          updated_at TEXT NOT NULL,
          PRIMARY KEY (id, revision),
          FOREIGN KEY (id) REFERENCES project_drafts(id)
        );
        PRAGMA user_version = 4;
        COMMIT;
      `)
      }
      if (version < 5) {
        this.db.exec(`
        BEGIN;
        CREATE TABLE pu66_verifications (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          key TEXT NOT NULL,
          card_revision INTEGER NOT NULL CHECK (card_revision > 0),
          verified_at TEXT NOT NULL,
          verified_by TEXT NOT NULL,
          recorded_at TEXT NOT NULL,
          FOREIGN KEY (key, card_revision) REFERENCES pu66_revisions(key, revision)
        );
        CREATE INDEX pu66_verifications_by_card ON pu66_verifications(key, card_revision, id);
        PRAGMA user_version = 5;
        COMMIT;
      `)
      }
      if (version < 6) {
        this.db.exec(`
        BEGIN;
        CREATE TABLE IF NOT EXISTS sign_catalog_batches (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          document_code TEXT NOT NULL,
          edition TEXT NOT NULL,
          pdf_sha256 TEXT,
          zip_sha256 TEXT NOT NULL,
          sign_count INTEGER NOT NULL,
          imported_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS sign_active (
          code TEXT PRIMARY KEY REFERENCES signs(code),
          batch_id INTEGER REFERENCES sign_catalog_batches(id)
        );
        CREATE TABLE IF NOT EXISTS sign_revisions (
          code TEXT NOT NULL,
          revision INTEGER NOT NULL,
          numbered_png BLOB NOT NULL,
          plain_png BLOB NOT NULL,
          numbered_sha256 TEXT NOT NULL,
          plain_sha256 TEXT NOT NULL,
          zip_sha256 TEXT NOT NULL,
          batch_id INTEGER REFERENCES sign_catalog_batches(id),
          active INTEGER NOT NULL CHECK (active IN (0, 1)),
          updated_at TEXT NOT NULL,
          PRIMARY KEY (code, revision)
        );
        INSERT OR IGNORE INTO sign_active (code, batch_id) SELECT code, NULL FROM signs;
        INSERT OR IGNORE INTO sign_revisions
          (code, revision, numbered_png, plain_png, numbered_sha256, plain_sha256,
           zip_sha256, batch_id, active, updated_at)
          SELECT code, revision, numbered_png, plain_png, numbered_sha256, plain_sha256,
                 zip_sha256, NULL, 1, updated_at FROM signs;
        PRAGMA user_version = 6;
        COMMIT;
      `)
      }
      if (version < 7) {
        this.db.exec(`
        BEGIN;
        CREATE TABLE project_sources (
          sha256 TEXT PRIMARY KEY,
          original_json TEXT NOT NULL
        );
        PRAGMA user_version = 7;
        COMMIT;
      `)
      }
      if (version < 8) {
        this.db.exec(`
        BEGIN;
        CREATE TABLE IF NOT EXISTS project_recovery (
          session_id TEXT PRIMARY KEY,
          version INTEGER NOT NULL CHECK (version > 0),
          scheme_json TEXT NOT NULL CHECK (json_valid(scheme_json)),
          base_revision INTEGER CHECK (base_revision >= 0),
          details_json TEXT CHECK (details_json IS NULL OR json_valid(details_json)),
          placement_json TEXT CHECK (placement_json IS NULL OR json_valid(placement_json)),
          file_name TEXT NOT NULL,
          reference_id TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        PRAGMA user_version = 8;
        COMMIT;
      `)
      }
      if (version < 9) this.migrateStationPu66Keys()
      if (version < 10) {
        this.db.exec(`
        BEGIN;
        CREATE TABLE IF NOT EXISTS normative_documents (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          code TEXT NOT NULL,
          edition TEXT NOT NULL,
          title TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('signs', 'rules', 'methodology', 'other')),
          effective_from TEXT NOT NULL,
          amends_id INTEGER REFERENCES normative_documents(id),
          note TEXT NOT NULL,
          actual_checked_at TEXT NOT NULL,
          filename TEXT NOT NULL,
          pdf BLOB NOT NULL,
          sha256 TEXT NOT NULL UNIQUE,
          size_bytes INTEGER NOT NULL,
          added_at TEXT NOT NULL
        );
        COMMIT;
      `)
        const columns = this.db.prepare('PRAGMA table_info(sign_catalog_batches)').all() as Array<{
          name: string
        }>
        if (!columns.some((column) => column.name === 'document_id'))
          this.db.exec(
            'ALTER TABLE sign_catalog_batches ADD COLUMN document_id INTEGER REFERENCES normative_documents(id)',
          )
        this.db.exec('PRAGMA user_version = 10')
      }
      if (version < 11) {
        this.db.exec(`
        BEGIN;
        CREATE TABLE IF NOT EXISTS document_pages (
          document_id INTEGER NOT NULL REFERENCES normative_documents(id),
          page INTEGER NOT NULL,
          text TEXT NOT NULL,
          PRIMARY KEY (document_id, page)
        );
        CREATE TABLE IF NOT EXISTS parameter_confirmations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          parameter_id TEXT NOT NULL,
          document_id INTEGER REFERENCES normative_documents(id),
          document_label TEXT NOT NULL,
          clause TEXT NOT NULL,
          page INTEGER,
          quote TEXT NOT NULL,
          fragment TEXT NOT NULL,
          value_json TEXT NOT NULL,
          confirmed_by TEXT NOT NULL,
          confirmed_at TEXT NOT NULL,
          note TEXT NOT NULL,
          recorded_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS parameter_confirmations_by_parameter
          ON parameter_confirmations(parameter_id, id);
        PRAGMA user_version = 11;
        COMMIT;
      `)
      }
      if (version < 12) {
        this.db.exec(`
          BEGIN;
          CREATE TABLE IF NOT EXISTS pu66_lifecycle (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            key TEXT NOT NULL,
            card_revision INTEGER NOT NULL,
            action TEXT NOT NULL CHECK (action IN ('exclude', 'restore')),
            date TEXT NOT NULL,
            actor TEXT NOT NULL,
            reason TEXT,
            comment TEXT NOT NULL,
            successor_key TEXT REFERENCES pu66_cards(key),
            recorded_at TEXT NOT NULL,
            FOREIGN KEY (key, card_revision) REFERENCES pu66_revisions(key, revision)
          );
          CREATE INDEX IF NOT EXISTS pu66_lifecycle_by_card ON pu66_lifecycle(key, id);
          PRAGMA user_version = 12;
          COMMIT;
        `)
      }
      if (version < 13) {
        this.db.exec(`
          BEGIN;
          ALTER TABLE project_recovery ADD COLUMN owner_id TEXT;
          ALTER TABLE project_recovery ADD COLUMN owner_until INTEGER NOT NULL DEFAULT 0;
          PRAGMA user_version = 13;
          COMMIT;
        `)
      }
      if (this.listNormative().length === 0) {
        for (const entry of initialNormativeEntries) this.saveNormative(entry, 0)
      }
    } catch (error) {
      // A failed multi-statement migration can leave a transaction open.
      try {
        this.db.exec('ROLLBACK')
      } catch {
        // No transaction was active.
      }
      this.db.close()
      throw error
    }
  }

  private rows(kind: RegistryKind): StoredRow[] {
    return this.db
      .prepare(`SELECT key, revision, payload_json, updated_at FROM ${kind} ORDER BY key`)
      .all() as StoredRow[]
  }

  private save(
    kind: RegistryKind,
    key: string,
    payload: CrossingDraft | NormativeDraft,
    expectedRevision: number,
  ): StoredRow {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const previous = this.db.prepare(`SELECT revision FROM ${kind} WHERE key = ?`).get(key) as
        { revision: number } | undefined
      if ((previous?.revision ?? 0) !== expectedRevision) throw new RevisionConflict()
      const revision = expectedRevision + 1
      const updatedAt = this.now()
      const json = JSON.stringify(payload)
      this.db
        .prepare(
          `INSERT INTO ${kind} (key, revision, payload_json, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET revision = excluded.revision, payload_json = excluded.payload_json, updated_at = excluded.updated_at`,
        )
        .run(key, revision, json, updatedAt)
      this.db
        .prepare(
          'INSERT INTO revisions (kind, key, revision, payload_json, updated_at) VALUES (?, ?, ?, ?, ?)',
        )
        .run(kind, key, revision, json, updatedAt)
      this.db.exec('COMMIT')
      return { key, revision, payload_json: json, updated_at: updatedAt }
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  /** Версия схемы локальной базы (`PRAGMA user_version`) — для диагностики. */
  schemaVersion(): number {
    return (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
  }

  listCrossings(): CrossingRecord[] {
    return this.rows('crossings').map((row) => ({
      ...crossingDraftSchema.parse(JSON.parse(row.payload_json)),
      revision: row.revision,
      updatedAt: row.updated_at,
    }))
  }

  saveCrossing(draft: CrossingDraft, expectedRevision: number): CrossingRecord {
    const parsed = crossingDraftSchema.parse(draft)
    const row = this.save('crossings', parsed.referenceId, parsed, expectedRevision)
    return { ...parsed, revision: row.revision, updatedAt: row.updated_at }
  }

  listNormative(): NormativeRecord[] {
    return this.rows('normative').map((row) => ({
      ...normativeDraftSchema.parse(JSON.parse(row.payload_json)),
      revision: row.revision,
      updatedAt: row.updated_at,
    }))
  }

  saveNormative(draft: NormativeDraft, expectedRevision: number): NormativeRecord {
    const parsed = normativeDraftSchema.parse(draft)
    const row = this.save('normative', parsed.id, parsed, expectedRevision)
    return { ...parsed, revision: row.revision, updatedAt: row.updated_at }
  }

  listProjects(): ProjectSummary[] {
    return this.db
      .prepare(
        `SELECT id, reference_id AS referenceId, location_text AS locationText,
          template_code AS templateCode, revision, updated_at AS updatedAt,
          ${summaryText('$.crossing.snapshot.location')} AS crossingLocation,
          ${summaryText('$.crossing.snapshot.roadName')} AS roadName,
          ${summaryText('$.parameters.directions.left')} AS directionLeft,
          ${summaryText('$.parameters.directions.right')} AS directionRight,
          ${summaryText('$.titleBlock.work.description')} AS workDescription
          FROM project_drafts ORDER BY updated_at DESC, id`,
      )
      .all() as ProjectSummary[]
  }

  /** The JSON export stays self-contained; only SQLite snapshots use a content reference. */
  private parseProject(payload: string): Scheme {
    const stored = JSON.parse(payload) as {
      source?: { kind?: string; originalJsonSha256?: unknown }
    }
    if (stored.source?.kind !== 'legacy-html-v1' || !('originalJsonSha256' in stored.source)) {
      return parseStoredScheme(stored)
    }
    const sha256 = stored.source.originalJsonSha256
    if (typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256)) {
      throw new Error('Повреждена ссылка на исходный JSON проекта в локальной базе.')
    }
    const row = this.db
      .prepare('SELECT original_json FROM project_sources WHERE sha256 = ?')
      .get(sha256) as { original_json: string } | undefined
    if (!row || createHash('sha256').update(row.original_json, 'utf8').digest('hex') !== sha256) {
      throw new Error('Исходный JSON проекта отсутствует или повреждён в локальной базе.')
    }
    const { originalJsonSha256: _hash, ...source } = stored.source
    void _hash
    return parseStoredScheme({
      ...stored,
      source: { ...source, originalJson: row.original_json },
    })
  }

  private storeProjectSource(scheme: Scheme): string {
    if (scheme.source.kind !== 'legacy-html-v1') return JSON.stringify(scheme)
    const { originalJson, ...source } = scheme.source
    const sha256 = createHash('sha256').update(originalJson, 'utf8').digest('hex')
    this.db
      .prepare(
        'INSERT INTO project_sources (sha256, original_json) VALUES (?, ?) ON CONFLICT(sha256) DO NOTHING',
      )
      .run(sha256, originalJson)
    return JSON.stringify({ ...scheme, source: { ...source, originalJsonSha256: sha256 } })
  }

  getProject(id: string): ProjectRecord | null {
    const row = this.db
      .prepare('SELECT revision, scheme_json, updated_at FROM project_drafts WHERE id = ?')
      .get(id) as (Pick<StoredRow, 'revision' | 'updated_at'> & { scheme_json: string }) | undefined
    return row
      ? {
          scheme: this.parseProject(row.scheme_json),
          revision: row.revision,
          updatedAt: row.updated_at,
        }
      : null
  }

  listProjectRevisions(id: string): ProjectRevision[] {
    return this.db
      .prepare(
        `SELECT revision, updated_at AS updatedAt FROM project_revisions
          WHERE id = ? ORDER BY revision DESC`,
      )
      .all(id) as ProjectRevision[]
  }

  getProjectRevision(id: string, revision: number): ProjectRecord | null {
    const row = this.db
      .prepare(
        'SELECT revision, scheme_json, updated_at FROM project_revisions WHERE id = ? AND revision = ?',
      )
      .get(id, revision) as
      (Pick<StoredRow, 'revision' | 'updated_at'> & { scheme_json: string }) | undefined
    return row
      ? {
          scheme: this.parseProject(row.scheme_json),
          revision: row.revision,
          updatedAt: row.updated_at,
        }
      : null
  }

  saveProject(scheme: Scheme, expectedRevision: number, forceRevision = false): ProjectRecord {
    const checked = schemeSchema.parse(scheme)
    const payload = JSON.stringify(checked)
    if (Buffer.byteLength(payload) > MAX_LOCAL_PROJECT_BYTES) throw new ProjectTooLarge()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const previous = this.db
        .prepare('SELECT revision, scheme_json, updated_at FROM project_drafts WHERE id = ?')
        .get(checked.id) as
        (Pick<StoredRow, 'revision' | 'updated_at'> & { scheme_json: string }) | undefined
      if ((previous?.revision ?? 0) !== expectedRevision) throw new RevisionConflict()
      if (
        !forceRevision &&
        previous &&
        JSON.stringify(this.parseProject(previous.scheme_json)) === payload
      ) {
        this.db.exec('COMMIT')
        return { scheme: checked, revision: previous.revision, updatedAt: previous.updated_at }
      }
      const revision = expectedRevision + 1
      const updatedAt = this.now()
      const storedPayload = this.storeProjectSource(checked)
      this.db
        .prepare(
          `INSERT INTO project_drafts
            (id, revision, scheme_json, reference_id, location_text, template_code, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET revision = excluded.revision,
              scheme_json = excluded.scheme_json, reference_id = excluded.reference_id,
              location_text = excluded.location_text, template_code = excluded.template_code,
              updated_at = excluded.updated_at`,
        )
        .run(
          checked.id,
          revision,
          storedPayload,
          checked.crossing.referenceId,
          checked.parameters.locationText,
          checked.template.code,
          updatedAt,
        )
      this.db
        .prepare(
          'INSERT INTO project_revisions (id, revision, scheme_json, updated_at) VALUES (?, ?, ?, ?)',
        )
        .run(checked.id, revision, storedPayload, updatedAt)
      this.db.exec('COMMIT')
      return { scheme: checked, revision, updatedAt }
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  restoreProject(
    id: string,
    sourceRevision: number,
    expectedRevision: number,
  ): ProjectRecord | null {
    const previous = this.getProjectRevision(id, sourceRevision)
    return previous ? this.saveProject(previous.scheme, expectedRevision, true) : null
  }

  listRecoveries(): RecoverySummary[] {
    return this.db
      .prepare(
        `SELECT session_id AS sessionId, version, base_revision AS baseRevision,
          file_name AS fileName, reference_id AS referenceId, updated_at AS updatedAt,
          owner_until AS ownerUntil
          FROM project_recovery ORDER BY updated_at DESC`,
      )
      .all()
      .map((row) => {
        const { ownerUntil, ...summary } = row
        return recoverySummarySchema.parse({
          ...summary,
          active: recoveryIsActive(Number(ownerUntil), Date.parse(this.now())),
        })
      })
  }

  getRecovery(sessionId: string, access?: { ownerId?: string }): RecoveryRecord | null {
    const row = this.db
      .prepare('SELECT * FROM project_recovery WHERE session_id = ?')
      .get(sessionId) as
      | {
          version: number
          owner_id: string | null
          owner_until: number
          scheme_json: string
          base_revision: number | null
          details_json: string | null
          placement_json: string | null
          file_name: string
          updated_at: string
        }
      | undefined
    if (
      access &&
      row &&
      row.owner_id !== access.ownerId &&
      recoveryIsActive(row.owner_until, Date.parse(this.now()))
    )
      throw new RecoveryOwned()
    return row
      ? recoveryRecordSchema.parse({
          sessionId,
          version: row.version,
          scheme: this.parseProject(row.scheme_json),
          baseRevision: row.base_revision,
          detailsDraft: row.details_json === null ? null : JSON.parse(row.details_json),
          placementDraft: row.placement_json === null ? null : JSON.parse(row.placement_json),
          fileName: row.file_name,
          updatedAt: row.updated_at,
        })
      : null
  }

  assertRecoveryAvailable(sessionId: string, ownerId?: string): void {
    const row = this.db
      .prepare('SELECT owner_id, owner_until FROM project_recovery WHERE session_id = ?')
      .get(sessionId) as { owner_id: string | null; owner_until: number } | undefined
    if (
      row &&
      row.owner_id !== ownerId &&
      recoveryIsActive(row.owner_until, Date.parse(this.now()))
    )
      throw new RecoveryOwned()
  }

  claimRecovery(sessionId: string, ownerId: string, expectedVersion: number): RecoveryRecord {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.assertRecoveryAvailable(sessionId, ownerId)
      const record = this.getRecovery(sessionId)
      if (!record || record.version !== expectedVersion) throw new RevisionConflict()
      this.db
        .prepare(
          'UPDATE project_recovery SET owner_id = ?, owner_until = ?, version = version + 1 WHERE session_id = ?',
        )
        .run(ownerId, Date.parse(this.now()) + RECOVERY_LEASE_MS, sessionId)
      this.db.exec('COMMIT')
      return { ...record, version: record.version + 1 }
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  heartbeatRecovery(sessionId: string, ownerId: string): void {
    const result = this.db
      .prepare('UPDATE project_recovery SET owner_until = ? WHERE session_id = ? AND owner_id = ?')
      .run(Date.parse(this.now()) + RECOVERY_LEASE_MS, sessionId, ownerId)
    if (!result.changes) throw new RecoveryOwned()
  }

  releaseRecovery(sessionId: string, ownerId: string): void {
    this.db
      .prepare('UPDATE project_recovery SET owner_until = 0 WHERE session_id = ? AND owner_id = ?')
      .run(sessionId, ownerId)
  }

  resolveRecoveryScheme(sessionId: string, value: unknown, sourceSha256?: string): Scheme {
    if (!sourceSha256) return schemeSchema.parse(value)
    // References only reuse the source already attached to this copy, never another project's data.
    const previous = this.getRecovery(sessionId)
    if (previous?.scheme.source.kind !== 'legacy-html-v1') throw new RevisionConflict()
    const originalJson = previous.scheme.source.originalJson
    if (createHash('sha256').update(originalJson, 'utf8').digest('hex') !== sourceSha256)
      throw new RevisionConflict()
    if (!value || typeof value !== 'object' || !('source' in value)) throw new RevisionConflict()
    const source = value.source
    if (
      !source ||
      typeof source !== 'object' ||
      !('kind' in source) ||
      source.kind !== 'legacy-html-v1' ||
      'originalJson' in source
    )
      throw new RevisionConflict()
    return schemeSchema.parse({ ...value, source: { ...source, originalJson } })
  }

  saveRecovery(input: RecoveryWrite, ownerId: string): RecoveryRecord {
    const payload = JSON.stringify(input)
    if (Buffer.byteLength(payload) > MAX_LOCAL_PROJECT_BYTES) throw new ProjectTooLarge()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const existing = this.db
        .prepare('SELECT version, owner_id FROM project_recovery WHERE session_id = ?')
        .get(input.sessionId) as { version: number; owner_id: string | null } | undefined
      this.assertRecoveryAvailable(input.sessionId, ownerId)
      if (existing?.owner_id && existing.owner_id !== ownerId) throw new RecoveryOwned()
      if ((existing?.version ?? 0) !== input.expectedVersion) throw new RevisionConflict()
      const version = input.expectedVersion + 1
      const updatedAt = this.now()
      this.db
        .prepare(
          `INSERT INTO project_recovery
            (session_id, version, scheme_json, base_revision, details_json, placement_json,
              file_name, reference_id, updated_at, owner_id, owner_until)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(session_id) DO UPDATE SET
              version = excluded.version, scheme_json = excluded.scheme_json,
              base_revision = excluded.base_revision, details_json = excluded.details_json,
              placement_json = excluded.placement_json, file_name = excluded.file_name,
              reference_id = excluded.reference_id, updated_at = excluded.updated_at,
              owner_id = excluded.owner_id, owner_until = excluded.owner_until`,
        )
        .run(
          input.sessionId,
          version,
          this.storeProjectSource(input.scheme),
          input.baseRevision,
          input.detailsDraft === null ? null : JSON.stringify(input.detailsDraft),
          input.placementDraft === null ? null : JSON.stringify(input.placementDraft),
          input.fileName,
          input.scheme.crossing.referenceId,
          updatedAt,
          ownerId,
          Date.parse(updatedAt) + RECOVERY_LEASE_MS,
        )
      this.db.exec('COMMIT')
      const { expectedVersion: _expectedVersion, ...record } = input
      void _expectedVersion
      return { ...record, version, updatedAt }
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  deleteRecovery(sessionId: string, expectedVersion: number, ownerId?: string): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.assertRecoveryAvailable(sessionId, ownerId)
      const existing = this.db
        .prepare('SELECT version, scheme_json FROM project_recovery WHERE session_id = ?')
        .get(sessionId) as { version: number; scheme_json: string } | undefined
      if (!existing || existing.version !== expectedVersion) throw new RevisionConflict()
      this.db.prepare('DELETE FROM project_recovery WHERE session_id = ?').run(sessionId)
      const stored = JSON.parse(existing.scheme_json) as {
        source?: { originalJsonSha256?: unknown }
      }
      const sha256 = stored.source?.originalJsonSha256
      if (typeof sha256 === 'string') {
        const referenced = this.db
          .prepare(
            `SELECT 1 FROM (
              SELECT scheme_json FROM project_drafts
              UNION ALL SELECT scheme_json FROM project_revisions
              UNION ALL SELECT scheme_json FROM project_recovery
            ) WHERE json_extract(scheme_json, '$.source.originalJsonSha256') = ? LIMIT 1`,
          )
          .get(sha256)
        if (!referenced) this.db.prepare('DELETE FROM project_sources WHERE sha256 = ?').run(sha256)
      }
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  /**
   * v9: станционные карточки получают номер карточки в ключе. Ранее разные карточки одной станции
   * с одинаковой привязкой «км:пк» сливались в одну запись; их редакции разделяются обратно,
   * а старый ключ сохраняется как псевдоним (NULL — если за ним стояло несколько карточек).
   */
  private migrateStationPu66Keys(): void {
    this.db.exec('BEGIN')
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS pu66_key_aliases (old_key TEXT PRIMARY KEY, new_key TEXT)',
    )
    const rows = this.db
      .prepare(
        `SELECT key, revision, payload_json, source_sha256, updated_at
         FROM pu66_revisions ORDER BY key, revision`,
      )
      .all() as Array<{
      key: string
      revision: number
      payload_json: string
      source_sha256: string
      updated_at: string
    }>
    const byOldKey = new Map<string, typeof rows>()
    for (const row of rows) {
      if (!legacyStationKey.test(row.key)) continue
      byOldKey.set(row.key, [...(byOldKey.get(row.key) ?? []), row])
    }
    const insertRevision = this.db.prepare(
      `INSERT INTO pu66_revisions (key, revision, payload_json, source_sha256, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    const moveVerifications = this.db.prepare(
      'UPDATE pu66_verifications SET key = ?, card_revision = ? WHERE key = ? AND card_revision = ?',
    )
    const deleteRevision = this.db.prepare(
      'DELETE FROM pu66_revisions WHERE key = ? AND revision = ?',
    )
    const insertCard = this.db.prepare(
      `INSERT INTO pu66_cards (key, revision, payload_json, source_sha256, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    const alias = this.db.prepare(
      'INSERT OR REPLACE INTO pu66_key_aliases (old_key, new_key) VALUES (?, ?)',
    )
    this.db.exec('PRAGMA defer_foreign_keys = ON')
    for (const [oldKey, history] of byOldKey) {
      const next = new Map<string, number>()
      const latest = new Map<string, (typeof rows)[number] & { newRevision: number }>()
      for (const row of history) {
        const card = JSON.parse(row.payload_json) as Pu66Card
        const newKey = `${oldKey}:к${card.cardNumber}`
        const newRevision = (next.get(newKey) ?? 0) + 1
        next.set(newKey, newRevision)
        const payload = JSON.stringify({ ...card, key: newKey })
        insertRevision.run(newKey, newRevision, payload, row.source_sha256, row.updated_at)
        moveVerifications.run(newKey, newRevision, oldKey, row.revision)
        deleteRevision.run(oldKey, row.revision)
        latest.set(newKey, { ...row, payload_json: payload, newRevision })
      }
      this.db.prepare('DELETE FROM pu66_cards WHERE key = ?').run(oldKey)
      for (const [newKey, row] of latest) {
        insertCard.run(newKey, row.newRevision, row.payload_json, row.source_sha256, row.updated_at)
      }
      alias.run(oldKey, latest.size === 1 ? [...latest.keys()][0]! : null)
    }
    this.db.exec('PRAGMA user_version = 9')
    this.db.exec('COMMIT')
  }

  /** Текущий ключ карточки; для старых станционных ключей — по таблице псевдонимов. */
  private resolvePu66Key(key: string): string | null {
    if (this.db.prepare('SELECT 1 FROM pu66_cards WHERE key = ?').get(key)) return key
    const alias = this.db
      .prepare('SELECT new_key FROM pu66_key_aliases WHERE old_key = ?')
      .get(key) as { new_key: string | null } | undefined
    if (!alias) return null
    if (alias.new_key === null) throw new AmbiguousPu66Key()
    return alias.new_key
  }

  getPu66Status(requestedKey: string): Pu66Status | null {
    const key = this.resolvePu66Key(requestedKey)
    if (!key) return null
    const event = this.listPu66Lifecycle(key)?.[0] ?? null
    return {
      referenceId: key,
      excluded: event?.action === 'exclude',
      event,
      successorKey: event?.action === 'exclude' ? event.successorKey : null,
    }
  }

  listPu66Lifecycle(requestedKey: string): Array<NonNullable<Pu66Status['event']>> | null {
    const key = this.resolvePu66Key(requestedKey)
    if (!key) return null
    const rows = this.db
      .prepare(
        `SELECT id, action, date, actor, reason, comment,
      successor_key, card_revision, recorded_at FROM pu66_lifecycle WHERE key = ? ORDER BY id DESC`,
      )
      .all(key) as Array<{
      id: number
      action: 'exclude' | 'restore'
      date: string
      actor: string
      reason: NonNullable<Pu66Status['event']>['reason']
      comment: string
      successor_key: string | null
      card_revision: number
      recorded_at: string
    }>
    return rows.map((row) => ({
      id: row.id,
      action: row.action,
      date: row.date,
      actor: row.actor,
      reason: row.reason,
      comment: row.comment,
      successorKey: row.successor_key,
      cardRevision: row.card_revision,
      recordedAt: row.recorded_at,
    }))
  }

  planPu66Lifecycle(raw: Pu66LifecycleWrite) {
    const input = pu66LifecycleWriteSchema.parse(raw)
    if (input.date > localCalendarDate(new Date(this.now())))
      throw new InvalidPu66Lifecycle('Дата действия не может быть в будущем.')
    const cards = this.listPu66(true)
    const items = input.keys.map((key) => {
      const card = cards.find((card) => card.referenceId === key)
      const status = this.getPu66Status(key)
      if (!card || !status) throw new InvalidPu66Lifecycle('Карточка не найдена. Обновите список.')
      if (status.excluded !== (input.action === 'restore')) throw new RevisionConflict()
      return {
        referenceId: key,
        location: card.location,
        roadName: card.roadName,
        revision: card.revision,
        status,
      }
    })
    let successor: (typeof items)[number] | null = null
    if (input.action === 'exclude' && input.successorKey) {
      const status = this.getPu66Status(input.successorKey)
      const card = cards.find((card) => card.referenceId === input.successorKey)
      if (!status || !card || status.excluded || input.keys.includes(status.referenceId))
        throw new InvalidPu66Lifecycle('Преемник должен быть другой действующей карточкой.')
      // A new link is recorded explicitly; legacy key aliases keep their original meaning.
      const key = status.referenceId
      if (key !== input.successorKey)
        throw new InvalidPu66Lifecycle('Выберите текущий ключ карточки-преемника.')
      successor = {
        referenceId: key,
        location: card.location,
        roadName: card.roadName,
        revision: card.revision,
        status,
      }
    }
    const fingerprint = createHash('sha256')
      .update(JSON.stringify({ input, items, successor }))
      .digest('hex')
    return { fingerprint, items, successor }
  }

  recordPu66Lifecycle(input: Pu66LifecycleWrite, expectedFingerprint: string): number {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const plan = this.planPu66Lifecycle(input)
      if (plan.fingerprint !== expectedFingerprint) throw new RevisionConflict()
      const insert = this.db.prepare(`INSERT INTO pu66_lifecycle
        (key, card_revision, action, date, actor, reason, comment, successor_key, recorded_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      const now = this.now()
      for (const item of plan.items) {
        insert.run(
          item.referenceId,
          item.revision,
          input.action,
          input.date,
          input.actor,
          input.action === 'exclude' ? input.reason : null,
          input.comment,
          input.action === 'exclude' ? input.successorKey : null,
          now,
        )
      }
      this.db.exec('COMMIT')
      return plan.items.length
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  planPu66(entries: Pu66Import[]): { added: number; updated: number; unchanged: number } {
    const result = { added: 0, updated: 0, unchanged: 0 }
    for (const entry of this.inspectPu66(entries)) {
      if (entry.action === 'add') result.added++
      else if (entry.action === 'update') result.updated++
      else result.unchanged++
    }
    return result
  }

  inspectPu66(entries: Pu66Import[]): Array<{
    filename: string
    referenceId: string
    location: string
    roadName: string
    action: 'add' | 'update' | 'unchanged'
    currentRevision: number
    sourceSha256: string
    status: Pu66Status | null
  }> {
    const seen = new Set<string>()
    const existing = this.db.prepare('SELECT revision, source_sha256 FROM pu66_cards WHERE key = ?')
    const result: ReturnType<RegistryStore['inspectPu66']> = []
    for (const entry of entries) {
      if (seen.has(entry.card.key)) throw new Error(`Повторный ключ ПУ-66: ${entry.card.key}.`)
      seen.add(entry.card.key)
      const previous = existing.get(entry.card.key) as
        { revision: number; source_sha256: string } | undefined
      result.push({
        filename: entry.filename,
        referenceId: entry.card.key,
        location: `${entry.card.kilometre} км ${entry.card.picket} пк`,
        roadName: entry.card.roadName,
        action: !previous
          ? 'add'
          : previous.source_sha256 === entry.sha256
            ? 'unchanged'
            : 'update',
        currentRevision: previous?.revision ?? 0,
        sourceSha256: entry.sha256,
        status: this.getPu66Status(entry.card.key),
      })
    }
    return result
  }

  importPu66(
    entries: Pu66Import[],
    restoration: Pu66ImportRestore | null = null,
  ): { added: number; updated: number; unchanged: number } {
    const result = this.planPu66(entries)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      if (restoration) {
        if (restoration.keys.some((key) => !entries.some((entry) => entry.card.key === key)))
          throw new InvalidPu66Lifecycle('Карточка для возврата отсутствует в пакете импорта.')
        this.planPu66Lifecycle({
          ...restoration,
          action: 'restore',
          comment: 'Возврат при импорте XLSX.',
        })
      }
      const source = this.db.prepare(
        'INSERT OR IGNORE INTO pu66_sources (sha256, original_name, workbook) VALUES (?, ?, ?)',
      )
      const current = this.db.prepare(
        `INSERT INTO pu66_cards (key, revision, payload_json, source_sha256, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET revision=excluded.revision, payload_json=excluded.payload_json,
         source_sha256=excluded.source_sha256, updated_at=excluded.updated_at`,
      )
      const revisionInsert = this.db.prepare(
        `INSERT INTO pu66_revisions (key, revision, payload_json, source_sha256, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      const previousQuery = this.db.prepare(
        'SELECT revision, source_sha256 FROM pu66_cards WHERE key = ?',
      )
      for (const entry of entries) {
        const previous = previousQuery.get(entry.card.key) as
          { revision: number; source_sha256: string } | undefined
        if (previous?.source_sha256 === entry.sha256) continue
        source.run(entry.sha256, entry.filename.slice(0, 240), entry.source)
        const revision = (previous?.revision ?? 0) + 1
        const updatedAt = this.now()
        const payload = JSON.stringify(entry.card)
        current.run(entry.card.key, revision, payload, entry.sha256, updatedAt)
        revisionInsert.run(entry.card.key, revision, payload, entry.sha256, updatedAt)
      }
      if (restoration) {
        const insert = this.db.prepare(`INSERT INTO pu66_lifecycle
          (key, card_revision, action, date, actor, reason, comment, successor_key, recorded_at)
          SELECT key, revision, 'restore', ?, ?, NULL, 'Возврат при импорте XLSX.', NULL, ?
          FROM pu66_cards WHERE key = ?`)
        for (const key of restoration.keys)
          insert.run(restoration.date, restoration.actor, this.now(), key)
      }
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  listPu66(includeExcluded = false): Array<
    ReturnType<typeof localCardSummary> & {
      revision: number
      updatedAt: string
      verification: Pu66Verification | null
    }
  > {
    const rows = this.db
      .prepare(
        `SELECT c.revision, c.payload_json, c.updated_at,
           v.verified_at, v.verified_by, v.recorded_at
         FROM pu66_cards AS c
         LEFT JOIN pu66_verifications AS v ON v.id = (
           SELECT id FROM pu66_verifications
           WHERE key = c.key AND card_revision = c.revision
           ORDER BY verified_at DESC, id DESC LIMIT 1
         )
         ${
           includeExcluded
             ? ''
             : `WHERE COALESCE((SELECT action FROM pu66_lifecycle
           WHERE key = c.key ORDER BY id DESC LIMIT 1), 'restore') <> 'exclude'`
         }
         ORDER BY c.key`,
      )
      .all() as Array<
      Pick<StoredRow, 'revision' | 'payload_json' | 'updated_at'> & {
        verified_at: string | null
        verified_by: string | null
        recorded_at: string | null
      }
    >
    return rows.map((row) => ({
      ...localCardSummary(JSON.parse(row.payload_json) as Pu66Card),
      revision: row.revision,
      updatedAt: row.updated_at,
      verification:
        row.verified_at && row.verified_by && row.recorded_at
          ? {
              cardRevision: row.revision,
              verifiedAt: row.verified_at,
              verifiedBy: row.verified_by,
              recordedAt: row.recorded_at,
            }
          : null,
    }))
  }

  recordPu66Verification(
    requestedKey: string,
    input: Pu66VerificationWrite,
  ): Pu66Verification | null {
    const { expectedRevision, verifiedAt, verifiedBy } = pu66VerificationWriteSchema.parse(input)
    const key = this.resolvePu66Key(requestedKey)
    if (!key) return null
    const now = this.now()
    if (verifiedAt > localCalendarDate(new Date(now))) throw new InvalidPu66Verification()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const current = this.db.prepare('SELECT revision FROM pu66_cards WHERE key = ?').get(key) as
        { revision: number } | undefined
      if (!current) {
        this.db.exec('ROLLBACK')
        return null
      }
      if (current.revision !== expectedRevision) throw new RevisionConflict()
      if (this.getPu66Status(key)?.excluded)
        throw new InvalidPu66Lifecycle(
          'Карточка исключена: верните её в действующие перед сверкой.',
        )
      this.db
        .prepare(
          `INSERT INTO pu66_verifications (key, card_revision, verified_at, verified_by, recorded_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(key, current.revision, verifiedAt, verifiedBy, now)
      this.db.exec('COMMIT')
      return { cardRevision: current.revision, verifiedAt, verifiedBy, recordedAt: now }
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  listPu66Verifications(requestedKey: string): Pu66Verification[] | null {
    const key = this.resolvePu66Key(requestedKey)
    if (!key) return null
    const rows = this.db
      .prepare(
        `SELECT card_revision, verified_at, verified_by, recorded_at
         FROM pu66_verifications WHERE key = ? ORDER BY id DESC`,
      )
      .all(key) as Array<{
      card_revision: number
      verified_at: string
      verified_by: string
      recorded_at: string
    }>
    return rows.map((row) => ({
      cardRevision: row.card_revision,
      verifiedAt: row.verified_at,
      verifiedBy: row.verified_by,
      recordedAt: row.recorded_at,
    }))
  }

  getPu66Scheme(
    requestedKey: string,
  ): (ReturnType<typeof schemeFields> & { revision: number; updatedAt: string }) | null {
    const key = this.resolvePu66Key(requestedKey)
    if (!key) return null
    const row = this.db
      .prepare('SELECT payload_json, revision, updated_at FROM pu66_cards WHERE key = ?')
      .get(key) as { payload_json: string; revision: number; updated_at: string } | undefined
    return row
      ? {
          ...schemeFields(JSON.parse(row.payload_json) as Pu66Card),
          revision: row.revision,
          updatedAt: row.updated_at,
        }
      : null
  }

  getPu66Norms(
    requestedKey: string,
  ): (ReturnType<typeof normativeFields> & { revision: number; updatedAt: string }) | null {
    const key = this.resolvePu66Key(requestedKey)
    if (!key) return null
    const row = this.db
      .prepare('SELECT payload_json, revision, updated_at FROM pu66_cards WHERE key = ?')
      .get(key) as { payload_json: string; revision: number; updated_at: string } | undefined
    return row
      ? {
          ...normativeFields(JSON.parse(row.payload_json) as Pu66Card),
          revision: row.revision,
          updatedAt: row.updated_at,
        }
      : null
  }

  latestSignCatalog(): {
    id: number
    documentCode: string
    edition: string
    pdfSha256: string | null
    zipSha256: string
    signCount: number
    importedAt: string
    documentId: number | null
  } | null {
    const row = this.db
      .prepare(
        `SELECT id, document_code, edition, pdf_sha256, zip_sha256, sign_count, imported_at,
                document_id FROM sign_catalog_batches ORDER BY id DESC LIMIT 1`,
      )
      .get() as
      | {
          id: number
          document_code: string
          edition: string
          pdf_sha256: string | null
          zip_sha256: string
          sign_count: number
          imported_at: string
          document_id: number | null
        }
      | undefined
    return row
      ? {
          id: row.id,
          documentCode: row.document_code,
          edition: row.edition,
          pdfSha256: row.pdf_sha256,
          zipSha256: row.zip_sha256,
          signCount: row.sign_count,
          importedAt: row.imported_at,
          documentId: row.document_id,
        }
      : null
  }

  planSigns(
    entries: SignImport[],
    source: SignCatalogSource = unspecifiedSignSource,
  ): SignCatalogPlan {
    const seen = new Set<string>()
    const result: SignCatalogPlan = {
      added: 0,
      updated: 0,
      unchanged: 0,
      retired: 0,
      relabelled: 0,
      addedCodes: [],
      changedCodes: [],
      retiredCodes: [],
    }
    const latest = this.latestSignCatalog()
    const sameSource =
      latest === null
        ? source.documentCode === unspecifiedSignSource.documentCode &&
          source.edition === unspecifiedSignSource.edition &&
          source.pdfSha256 === null
        : latest.documentCode === source.documentCode &&
          latest.edition === source.edition &&
          latest.pdfSha256 === source.pdfSha256
    const existing = this.db.prepare(
      `SELECT s.numbered_sha256, s.plain_sha256, a.code AS active
         FROM signs s LEFT JOIN sign_active a ON a.code = s.code WHERE s.code = ?`,
    )
    for (const entry of entries) {
      if (seen.has(entry.code)) throw new Error(`Повторный код знака: ${entry.code}.`)
      seen.add(entry.code)
      const previous = existing.get(entry.code) as
        { numbered_sha256: string; plain_sha256: string; active: string | null } | undefined
      const samePng =
        previous?.numbered_sha256 === entry.numberedSha256 &&
        previous.plain_sha256 === entry.plainSha256
      if (!previous || !previous.active) {
        result.added++
        result.addedCodes.push(entry.code)
      } else if (samePng && sameSource) result.unchanged++
      else {
        result.updated++
        if (samePng) result.relabelled++
        else result.changedCodes.push(entry.code)
      }
    }
    const active = this.db.prepare('SELECT code FROM sign_active').all() as { code: string }[]
    result.retiredCodes = active.filter(({ code }) => !seen.has(code)).map(({ code }) => code)
    result.retired = result.retiredCodes.length
    return result
  }

  importSigns(
    entries: SignImport[],
    source: SignCatalogSource = unspecifiedSignSource,
  ): SignCatalogPlan {
    const result = this.planSigns(entries, source)
    if (result.added + result.updated + result.retired === 0) return result
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const batch = this.db
        .prepare(
          `INSERT INTO sign_catalog_batches
          (document_code, edition, pdf_sha256, zip_sha256, sign_count, imported_at, document_id)
          VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
        )
        .get(
          source.documentCode,
          source.edition,
          source.pdfSha256,
          entries[0]?.zipSha256 ?? '',
          entries.length,
          this.now(),
          source.documentId ?? null,
        ) as { id: number }
      const existing = this.db.prepare(
        'SELECT numbered_sha256, plain_sha256, revision FROM signs WHERE code = ?',
      )
      const lastActivity = this.db.prepare(
        'SELECT active FROM sign_revisions WHERE code = ? ORDER BY revision DESC LIMIT 1',
      )
      const save = this.db.prepare(
        `INSERT INTO signs (code, numbered_png, plain_png, numbered_sha256, plain_sha256,
          zip_sha256, width, height, revision, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(code) DO UPDATE SET numbered_png=excluded.numbered_png, plain_png=excluded.plain_png,
          numbered_sha256=excluded.numbered_sha256,
          plain_sha256=excluded.plain_sha256, zip_sha256=excluded.zip_sha256, width=excluded.width,
          height=excluded.height, revision=excluded.revision, updated_at=excluded.updated_at`,
      )
      const revision = this.db.prepare(
        `INSERT INTO sign_revisions
          (code, revision, numbered_png, plain_png, numbered_sha256, plain_sha256,
           zip_sha256, batch_id, active, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      this.db.exec('DELETE FROM sign_active')
      const activate = this.db.prepare('INSERT INTO sign_active (code, batch_id) VALUES (?, ?)')
      for (const entry of entries) {
        const previous = existing.get(entry.code) as
          | {
              numbered_sha256: string
              plain_sha256: string
              revision: number
            }
          | undefined
        const samePng =
          previous?.numbered_sha256 === entry.numberedSha256 &&
          previous.plain_sha256 === entry.plainSha256
        const wasActive = lastActivity.get(entry.code) as { active: number } | undefined
        if (samePng && wasActive?.active === 1) {
          activate.run(entry.code, batch.id)
          continue
        }
        const nextRevision = (previous?.revision ?? 0) + 1
        const updatedAt = this.now()
        save.run(
          entry.code,
          entry.numberedPng,
          entry.plainPng,
          entry.numberedSha256,
          entry.plainSha256,
          entry.zipSha256,
          entry.width,
          entry.height,
          nextRevision,
          updatedAt,
        )
        revision.run(
          entry.code,
          nextRevision,
          entry.numberedPng,
          entry.plainPng,
          entry.numberedSha256,
          entry.plainSha256,
          entry.zipSha256,
          batch.id,
          1,
          updatedAt,
        )
        activate.run(entry.code, batch.id)
      }
      const retired = this.db
        .prepare(
          `SELECT s.* FROM signs s LEFT JOIN sign_active a ON a.code = s.code
                  WHERE a.code IS NULL`,
        )
        .all() as Array<{
        code: string
        revision: number
        numbered_png: Uint8Array
        plain_png: Uint8Array
        numbered_sha256: string
        plain_sha256: string
        zip_sha256: string
      }>
      const bump = this.db.prepare('UPDATE signs SET revision = ?, updated_at = ? WHERE code = ?')
      for (const old of retired) {
        const previous = lastActivity.get(old.code) as { active: number } | undefined
        if (previous?.active === 0) continue
        const updatedAt = this.now()
        bump.run(old.revision + 1, updatedAt, old.code)
        revision.run(
          old.code,
          old.revision + 1,
          old.numbered_png,
          old.plain_png,
          old.numbered_sha256,
          old.plain_sha256,
          old.zip_sha256,
          batch.id,
          0,
          updatedAt,
        )
      }
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  listSigns(
    query = '',
    limit = 100,
  ): Array<{ code: string; width: number; height: number; revision: number }> {
    const rows = this.db
      .prepare(
        "SELECT s.code, s.width, s.height, s.revision FROM signs s JOIN sign_active a ON a.code = s.code WHERE s.code LIKE ? ESCAPE '\\' ORDER BY s.code LIMIT ?",
      )
      .all(`%${query.replace(/[\\%_]/g, '\\$&')}%`, limit) as Array<{
      code: string
      width: number
      height: number
      revision: number
    }>
    return rows.map((row) => ({
      code: row.code,
      width: row.width,
      height: row.height,
      revision: row.revision,
    }))
  }

  /** Размеры именно выбранного PNG; история не подменяется активным каталогом. */
  getSignMetadata(
    code: string,
    revision: number,
  ): { code: string; revision: number; width: number; height: number } | null {
    const asset = this.getSignPng(code, false, revision)
    if (!asset) return null
    const png = Buffer.from(asset)
    if (
      png.length < 24 ||
      !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
      png.toString('ascii', 12, 16) !== 'IHDR'
    )
      return null
    const width = png.readUInt32BE(16)
    const height = png.readUInt32BE(20)
    if (!width || !height) return null
    return { code, revision, width, height }
  }

  getSignPng(code: string, numbered: boolean, revision?: number): Uint8Array | null {
    const column = numbered ? 'numbered_png' : 'plain_png'
    const row = this.db
      .prepare(
        revision === undefined
          ? `SELECT ${column} AS asset FROM signs JOIN sign_active USING (code) WHERE code = ?`
          : `SELECT ${column} AS asset FROM sign_revisions WHERE code = ? AND revision = ? AND active = 1`,
      )
      .get(...(revision === undefined ? [code] : [code, revision])) as
      { asset: Uint8Array } | undefined
    return row?.asset ?? null
  }

  history(
    kind: RegistryKind,
    key: string,
  ): { revision: number; payload: unknown; updatedAt: string }[] {
    return (
      this.db
        .prepare(
          'SELECT revision, payload_json, updated_at FROM revisions WHERE kind = ? AND key = ? ORDER BY revision',
        )
        .all(kind, key) as Omit<StoredRow, 'key'>[]
    ).map((row) => ({
      revision: row.revision,
      payload: JSON.parse(row.payload_json),
      updatedAt: row.updated_at,
    }))
  }

  /** Каталог резервных копий: `backups/` рядом с файлом базы, в том числе заданным `TOD_DATABASE_PATH`. */
  get backupDirectory(): string {
    return join(dirname(this.path), 'backups')
  }

  private documentRow(row: Record<string, unknown>): DocumentRecord {
    return {
      id: Number(row.id),
      code: String(row.code),
      edition: String(row.edition),
      title: String(row.title),
      kind: row.kind as DocumentRecord['kind'],
      effectiveFrom: String(row.effective_from),
      amendsId: row.amends_id === null ? null : Number(row.amends_id),
      note: String(row.note),
      actualCheckedAt: String(row.actual_checked_at),
      filename: String(row.filename),
      sha256: String(row.sha256),
      sizeBytes: Number(row.size_bytes),
      addedAt: String(row.added_at),
    }
  }

  /** Библиотека нормативных документов без содержимого PDF. */
  listDocuments(): DocumentRecord[] {
    return (
      this.db
        .prepare(
          `SELECT id, code, edition, title, kind, effective_from, amends_id, note,
                  actual_checked_at, filename, sha256, size_bytes, added_at
             FROM normative_documents ORDER BY code, effective_from, id`,
        )
        .all() as Record<string, unknown>[]
    ).map((row) => this.documentRow(row))
  }

  getDocument(id: number): DocumentRecord | null {
    return this.listDocuments().find((document) => document.id === id) ?? null
  }

  getDocumentPdf(id: number): { filename: string; pdf: Uint8Array } | null {
    const row = this.db
      .prepare('SELECT filename, pdf FROM normative_documents WHERE id = ?')
      .get(id) as { filename: string; pdf: Uint8Array } | undefined
    return row ?? null
  }

  findDocumentBySha(sha256: string): DocumentRecord | null {
    return this.listDocuments().find((document) => document.sha256 === sha256) ?? null
  }

  private checkAmends(meta: DocumentMeta, selfId: number | null): void {
    if (meta.amendsId === null) return
    if (meta.amendsId === selfId) throw new DocumentInUse('Документ не может изменять сам себя.')
    const base = this.getDocument(meta.amendsId)
    if (!base) throw new DocumentInUse('Изменяемый документ не найден в библиотеке.')
    if (base.amendsId !== null)
      throw new DocumentInUse(
        'Изменение прикрепляется к основному документу, а не к другому изменению.',
      )
    if (selfId !== null) {
      const dependants = this.listDocuments().filter((item) => item.amendsId === selfId)
      if (dependants.length)
        throw new DocumentInUse(
          'К этому документу прикреплены изменения: он не может сам быть изменением.',
        )
    }
  }

  addDocument(
    input: DocumentMeta,
    filename: string,
    pdf: Uint8Array,
    sha256: string,
  ): DocumentRecord {
    const meta = documentMetaSchema.parse(input)
    if (this.findDocumentBySha(sha256)) throw new DocumentInUse('Этот PDF уже есть в библиотеке.')
    this.checkAmends(meta, null)
    const row = this.db
      .prepare(
        `INSERT INTO normative_documents
          (code, edition, title, kind, effective_from, amends_id, note, actual_checked_at,
           filename, pdf, sha256, size_bytes, added_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      )
      .get(
        meta.code,
        meta.edition,
        meta.title,
        meta.kind,
        meta.effectiveFrom,
        meta.amendsId,
        meta.note,
        meta.actualCheckedAt,
        filename,
        pdf,
        sha256,
        pdf.byteLength,
        this.now(),
      ) as { id: number }
    return this.getDocument(row.id)!
  }

  updateDocument(id: number, input: DocumentMeta): DocumentRecord | null {
    const meta = documentMetaSchema.parse(input)
    const existing = this.getDocument(id)
    if (!existing) return null
    if (existing.kind !== meta.kind) {
      // Партия каталога знаков ссылается на документ как на стандарт знаков: после смены
      // вида история каталога указывала бы на документ, из которого знаки взять нельзя.
      const batches = this.db
        .prepare('SELECT COUNT(*) AS count FROM sign_catalog_batches WHERE document_id = ?')
        .get(id) as { count: number }
      if (batches.count)
        throw new DocumentInUse(
          'С этим документом сверен импорт каталога знаков: вид документа изменить нельзя.',
        )
    }
    this.checkAmends(meta, id)
    this.db
      .prepare(
        `UPDATE normative_documents SET code = ?, edition = ?, title = ?, kind = ?,
           effective_from = ?, amends_id = ?, note = ?, actual_checked_at = ? WHERE id = ?`,
      )
      .run(
        meta.code,
        meta.edition,
        meta.title,
        meta.kind,
        meta.effectiveFrom,
        meta.amendsId,
        meta.note,
        meta.actualCheckedAt,
        id,
      )
    return this.getDocument(id)
  }

  /** Удаление допустимо, только если на документ не ссылаются каталог знаков и изменения. */
  deleteDocument(id: number): boolean {
    if (!this.getDocument(id)) return false
    const batches = this.db
      .prepare('SELECT COUNT(*) AS count FROM sign_catalog_batches WHERE document_id = ?')
      .get(id) as { count: number }
    if (batches.count)
      throw new DocumentInUse(
        'С этим документом сверен импорт каталога знаков: запись нужна для истории и не удаляется.',
      )
    if (this.listDocuments().some((document) => document.amendsId === id))
      throw new DocumentInUse('Сначала удалите изменения, прикреплённые к этому документу.')
    const confirmations = this.db
      .prepare('SELECT COUNT(*) AS count FROM parameter_confirmations WHERE document_id = ?')
      .get(id) as { count: number }
    if (confirmations.count)
      throw new DocumentInUse(
        'По этому документу подтверждены нормативные параметры: запись нужна для истории и не удаляется.',
      )
    this.db.prepare('DELETE FROM document_pages WHERE document_id = ?').run(id)
    this.db.prepare('DELETE FROM normative_documents WHERE id = ?').run(id)
    return true
  }

  /** Сохранённый текст страниц документа или null, если текст ещё не извлекался. */
  getDocumentText(id: number): string[] | null {
    const rows = this.db
      .prepare('SELECT page, text FROM document_pages WHERE document_id = ? ORDER BY page')
      .all(id) as Array<{ page: number; text: string }>
    return rows.length ? rows.map((row) => row.text) : null
  }

  saveDocumentText(id: number, pages: readonly string[]): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare('DELETE FROM document_pages WHERE document_id = ?').run(id)
      const insert = this.db.prepare(
        'INSERT INTO document_pages (document_id, page, text) VALUES (?, ?, ?)',
      )
      // Пустой документ (скан без текста) сохраняется одной пустой страницей, чтобы не
      // разбирать его повторно.
      ;(pages.length ? pages : ['']).forEach((text, index) => insert.run(id, index + 1, text))
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  listParameterConfirmations(): ParameterConfirmation[] {
    return (
      this.db
        .prepare(
          `SELECT id, parameter_id, document_id, document_label, clause, page, quote, fragment,
                  value_json, confirmed_by, confirmed_at, note
             FROM parameter_confirmations ORDER BY parameter_id, id`,
        )
        .all() as Array<Record<string, unknown>>
    ).map((row) => ({
      id: Number(row.id),
      parameterId: String(row.parameter_id),
      documentId: row.document_id === null ? null : Number(row.document_id),
      documentLabel: String(row.document_label),
      clause: String(row.clause),
      page: row.page === null ? null : Number(row.page),
      quote: String(row.quote),
      fragment: String(row.fragment),
      value: JSON.parse(String(row.value_json)) as ParameterConfirmation['value'],
      confirmedBy: String(row.confirmed_by),
      confirmedAt: String(row.confirmed_at),
      note: String(row.note),
    }))
  }

  addParameterConfirmation(input: Omit<ParameterConfirmation, 'id'>): ParameterConfirmation {
    const row = this.db
      .prepare(
        `INSERT INTO parameter_confirmations
          (parameter_id, document_id, document_label, clause, page, quote, fragment, value_json,
           confirmed_by, confirmed_at, note, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      )
      .get(
        input.parameterId,
        input.documentId,
        input.documentLabel,
        input.clause,
        input.page,
        input.quote,
        input.fragment,
        JSON.stringify(input.value),
        input.confirmedBy,
        input.confirmedAt,
        input.note,
        this.now(),
      ) as { id: number }
    return { ...input, id: row.id }
  }

  /**
   * Копия файла до изменения схемы. Имя отличается от копий по кнопке, поэтому
   * `backups:prune` такие файлы не удаляет: к прежней версии базы можно вернуться только по ним.
   * Версия 2 не копируется: её обновление удаляет векторные изображения знаков без остатка,
   * а копия сохранила бы их.
   */
  private backupBeforeMigration(version: number): string | null {
    if (version === 2) return null
    const directory = this.backupDirectory
    const filename = `registry-before-update-v${version}-${this.now().replaceAll(':', '-').replaceAll('.', '-')}-${randomUUID().slice(0, 8)}.sqlite`
    const path = join(directory, filename)
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 })
      this.db.prepare('VACUUM INTO ?').run(path)
      if (process.platform !== 'win32') chmodSync(path, 0o600)
    } catch (error) {
      try {
        rmSync(path, { force: true })
      } catch {
        // Каталог копий недоступен: удалять нечего, важна исходная причина.
      }
      throw new Error(
        `Не удалось сохранить копию базы перед обновлением (${error instanceof Error ? error.message : String(error)}). База не изменена: освободите место или проверьте доступ к папке ${directory} и запустите программу снова.`,
      )
    }
    return filename
  }

  async createBackup(): Promise<string> {
    if (this.path === ':memory:') throw new Error('Нельзя сохранить резервную копию базы в памяти.')
    const directory = this.backupDirectory
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const filename = `registry-${this.now().replaceAll(':', '-').replaceAll('.', '-')}-${randomUUID().slice(0, 8)}.sqlite`
    const path = join(directory, filename)
    try {
      this.db.prepare('VACUUM INTO ?').run(path)
      if (process.platform !== 'win32') chmodSync(path, 0o600)
    } catch (error) {
      rmSync(path, { force: true })
      throw error
    }
    return filename
  }

  close(): void {
    this.db.close()
  }
}
