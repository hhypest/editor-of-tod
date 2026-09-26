import { closeSync, constants, existsSync, mkdirSync, openSync, chmodSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { backup, DatabaseSync } from 'node:sqlite'
import {
  crossingDraftSchema,
  normativeDraftSchema,
  type CrossingDraft,
  type CrossingRecord,
  type NormativeDraft,
  type NormativeRecord,
} from '../src/domain/registry.ts'

type RegistryKind = 'crossings' | 'normative'
type StoredRow = { key: string; revision: number; payload_json: string; updated_at: string }

export class RevisionConflict extends Error {
  constructor() {
    super('Запись изменилась после открытия. Обновите реестр и повторите правку.')
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
    if (version !== 0 && version !== 1) {
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
    await backup(this.db, path)
    if (process.platform !== 'win32') chmodSync(path, 0o600)
    return filename
  }

  close(): void {
    this.db.close()
  }
}
