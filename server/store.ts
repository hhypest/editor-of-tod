import { closeSync, constants, existsSync, mkdirSync, openSync, chmodSync, rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { parseStoredScheme, schemeSchema, type Scheme } from '../src/domain/model.ts'
import {
  MAX_LOCAL_PROJECT_BYTES,
  type ProjectRecord,
  type ProjectRevision,
  type ProjectSummary,
} from '../src/domain/local-projects.ts'
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
import { type Pu66Card, type Pu66Import, localCardSummary, schemeFields } from './pu66.ts'
import { type SignImport } from './signs.ts'

type RegistryKind = 'crossings' | 'normative'
type StoredRow = { key: string; revision: number; payload_json: string; updated_at: string }

export class RevisionConflict extends Error {
  constructor() {
    super('Запись изменилась после открытия. Обновите реестр и повторите правку.')
  }
}

export class ProjectTooLarge extends Error {
  constructor() {
    super('Черновик больше 32 МБ. Скачайте JSON-копию проекта.')
  }
}

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

export class RegistryStore {
  private readonly db: DatabaseSync
  readonly path: string
  private readonly now: () => string

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
    this.db.exec('PRAGMA foreign_keys = ON')
    const version = (this.db.prepare('PRAGMA user_version').get() as { user_version: number })
      .user_version
    if (
      version !== 0 &&
      version !== 1 &&
      version !== 2 &&
      version !== 3 &&
      version !== 4 &&
      version !== 5
    ) {
      this.db.close()
      throw new Error(`Неизвестная версия локальной базы: ${version}. Файл не изменён.`)
    }
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
    if (this.listNormative().length === 0) {
      for (const entry of initialNormativeEntries) this.saveNormative(entry, 0)
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
          template_code AS templateCode, revision, updated_at AS updatedAt
          FROM project_drafts ORDER BY updated_at DESC, id`,
      )
      .all() as ProjectSummary[]
  }

  getProject(id: string): ProjectRecord | null {
    const row = this.db
      .prepare('SELECT revision, scheme_json, updated_at FROM project_drafts WHERE id = ?')
      .get(id) as (Pick<StoredRow, 'revision' | 'updated_at'> & { scheme_json: string }) | undefined
    return row
      ? {
          scheme: parseStoredScheme(JSON.parse(row.scheme_json)),
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
          scheme: parseStoredScheme(JSON.parse(row.scheme_json)),
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
        JSON.stringify(parseStoredScheme(JSON.parse(previous.scheme_json))) === payload
      ) {
        this.db.exec('COMMIT')
        return { scheme: checked, revision: previous.revision, updatedAt: previous.updated_at }
      }
      const revision = expectedRevision + 1
      const updatedAt = this.now()
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
          payload,
          checked.crossing.referenceId,
          checked.parameters.locationText,
          checked.template.code,
          updatedAt,
        )
      this.db
        .prepare(
          'INSERT INTO project_revisions (id, revision, scheme_json, updated_at) VALUES (?, ?, ?, ?)',
        )
        .run(checked.id, revision, payload, updatedAt)
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

  planPu66(entries: Pu66Import[]): { added: number; updated: number; unchanged: number } {
    const seen = new Set<string>()
    const result = { added: 0, updated: 0, unchanged: 0 }
    const existing = this.db.prepare('SELECT source_sha256 FROM pu66_cards WHERE key = ?')
    for (const entry of entries) {
      if (seen.has(entry.card.key)) throw new Error(`Повторный ключ ПУ-66: ${entry.card.key}.`)
      seen.add(entry.card.key)
      const previous = existing.get(entry.card.key) as { source_sha256: string } | undefined
      if (!previous) result.added++
      else if (previous.source_sha256 === entry.sha256) result.unchanged++
      else result.updated++
    }
    return result
  }

  importPu66(entries: Pu66Import[]): { added: number; updated: number; unchanged: number } {
    const result = this.planPu66(entries)
    this.db.exec('BEGIN IMMEDIATE')
    try {
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
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  listPu66(): Array<
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
           ORDER BY id DESC LIMIT 1
         )
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

  recordPu66Verification(key: string, input: Pu66VerificationWrite): Pu66Verification | null {
    const { expectedRevision, verifiedAt, verifiedBy } = pu66VerificationWriteSchema.parse(input)
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

  listPu66Verifications(key: string): Pu66Verification[] | null {
    const current = this.db.prepare('SELECT 1 FROM pu66_cards WHERE key = ?').get(key)
    if (!current) return null
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
    key: string,
  ): (ReturnType<typeof schemeFields> & { revision: number; updatedAt: string }) | null {
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

  planSigns(entries: SignImport[]): { added: number; updated: number; unchanged: number } {
    const seen = new Set<string>()
    const result = { added: 0, updated: 0, unchanged: 0 }
    const existing = this.db.prepare(
      'SELECT numbered_sha256, plain_sha256 FROM signs WHERE code = ?',
    )
    for (const entry of entries) {
      if (seen.has(entry.code)) throw new Error(`Повторный код знака: ${entry.code}.`)
      seen.add(entry.code)
      const previous = existing.get(entry.code) as
        { numbered_sha256: string; plain_sha256: string } | undefined
      if (!previous) result.added++
      else if (
        previous.numbered_sha256 === entry.numberedSha256 &&
        previous.plain_sha256 === entry.plainSha256
      )
        result.unchanged++
      else result.updated++
    }
    return result
  }

  importSigns(entries: SignImport[]): { added: number; updated: number; unchanged: number } {
    const result = this.planSigns(entries)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const existing = this.db.prepare(
        'SELECT numbered_sha256, plain_sha256, revision FROM signs WHERE code = ?',
      )
      const save = this.db.prepare(
        `INSERT INTO signs (code, numbered_png, plain_png, numbered_sha256, plain_sha256,
          zip_sha256, width, height, revision, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(code) DO UPDATE SET numbered_png=excluded.numbered_png, plain_png=excluded.plain_png,
          numbered_sha256=excluded.numbered_sha256,
          plain_sha256=excluded.plain_sha256, zip_sha256=excluded.zip_sha256, width=excluded.width,
          height=excluded.height, revision=excluded.revision, updated_at=excluded.updated_at`,
      )
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
        if (samePng) continue
        save.run(
          entry.code,
          entry.numberedPng,
          entry.plainPng,
          entry.numberedSha256,
          entry.plainSha256,
          entry.zipSha256,
          entry.width,
          entry.height,
          (previous?.revision ?? 0) + 1,
          this.now(),
        )
      }
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  listSigns(query = '', limit = 100): Array<{ code: string; width: number; height: number }> {
    const rows = this.db
      .prepare(
        "SELECT code, width, height FROM signs WHERE code LIKE ? ESCAPE '\\' ORDER BY code LIMIT ?",
      )
      .all(`%${query.replace(/[\\%_]/g, '\\$&')}%`, limit) as Array<{
      code: string
      width: number
      height: number
    }>
    return rows.map((row) => ({
      code: row.code,
      width: row.width,
      height: row.height,
    }))
  }

  getSignPng(code: string, numbered: boolean): Uint8Array | null {
    const column = numbered ? 'numbered_png' : 'plain_png'
    const row = this.db.prepare(`SELECT ${column} AS asset FROM signs WHERE code = ?`).get(code) as
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

  async createBackup(): Promise<string> {
    if (this.path === ':memory:') throw new Error('Нельзя сохранить резервную копию базы в памяти.')
    const directory = join(dirname(this.path), 'backups')
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
