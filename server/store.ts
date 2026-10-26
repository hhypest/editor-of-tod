import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDatabase } from './database/connection.ts'
import { migrateDatabase } from './database/migration-runner.ts'
import { SCHEMA_VERSION, readSchemaVersion } from './database/schema-version.ts'
import { databaseBackupDirectory, createManualBackup } from './database/backups.ts'
import {
  LegacyRegistryRepository,
  type LegacyRegistryKind,
} from './legacy/legacy-registry-repository.ts'
import { initialNormativeEntries } from './legacy/initial-normative-entries.ts'
import { ProjectRepository } from './projects/project-repository.ts'
import { RecoveryRepository, type RecoverySaveInput } from './recovery/recovery-repository.ts'
import { RevisionConflict, ProjectTooLarge, RecoveryOwned } from './storage-errors.ts'
import { ProjectSourceStore } from './projects/project-source-store.ts'
import type { Scheme } from '../src/domain/model.ts'
import {
  type ProjectRecord,
  type ProjectRevision,
  type ProjectSummary,
} from '../src/domain/local-projects.ts'
import { type RecoveryRecord, type RecoverySummary } from '../src/domain/recovery.ts'
import {
  type CrossingDraft,
  type CrossingRecord,
  type NormativeDraft,
  type NormativeRecord,
} from '../src/domain/registry.ts'
import { type Pu66Verification, type Pu66VerificationWrite } from '../src/domain/pu66-review.ts'
import type { Pu66Import } from './pu66.ts'
import {
  Pu66Repository,
  type Pu66Summary,
  type Pu66Scheme,
  type Pu66Norms,
} from './pu66/repository.ts'
import { Pu66KeyResolver } from './pu66/key-resolver.ts'
import { AmbiguousPu66Key, InvalidPu66Lifecycle, InvalidPu66Verification } from './pu66/errors.ts'
import { Pu66VerificationRepository } from './pu66/verification-repository.ts'
import { Pu66LifecycleRepository } from './pu66/lifecycle-repository.ts'
import { Pu66LifecycleService } from './pu66/lifecycle-service.ts'
import { Pu66ImportRepository } from './pu66/import-repository.ts'
import { Pu66ImportService } from './pu66/import-service.ts'
import { SqliteTransactionRunner } from './database/transaction-runner.ts'
import { type SignImport } from './signs.ts'
import {
  type Pu66LifecyclePlan,
  type Pu66LifecycleWrite,
  type Pu66Status,
  type Pu66ImportRestore,
} from '../src/domain/pu66-lifecycle.ts'
import type { DocumentMeta, DocumentRecord } from '../src/domain/normative-documents.ts'
import { NormativeDocumentRepository } from './documents/normative-document-repository.ts'
import { NormativeDocumentService } from './documents/normative-document-service.ts'
import { DeleteNormativeDocument } from './documents/delete-normative-document.ts'
import { SignCatalogDocumentReferences } from './signs/document-references.ts'
import { DocumentTextRepository } from './documents/document-text-repository.ts'
import { ParameterConfirmationRepository } from './parameters/confirmation-repository.ts'

import type { ParameterConfirmation } from '../src/domain/normative-parameters.ts'

export { DocumentInUse } from './documents/errors.ts'

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

const unspecifiedSignSource: SignCatalogSource = {
  documentCode: 'Источник не указан',
  edition: 'не указана',
  pdfSha256: null,
}

export {
  RevisionConflict,
  ProjectTooLarge,
  RecoveryOwned,
  AmbiguousPu66Key,
  InvalidPu66Lifecycle,
  InvalidPu66Verification,
}

/** Текущая версия схемы локальной базы (`PRAGMA user_version`). */
export { SCHEMA_VERSION }

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
  private readonly projectSources: ProjectSourceStore
  private readonly projects: ProjectRepository
  private readonly recovery: RecoveryRepository
  private readonly legacy: LegacyRegistryRepository
  private readonly pu66Keys: Pu66KeyResolver
  private readonly pu66: Pu66Repository
  private readonly pu66Lifecycle: Pu66LifecycleRepository
  private readonly pu66LifecycleService: Pu66LifecycleService
  private readonly documents: NormativeDocumentRepository
  private readonly documentText: DocumentTextRepository
  private readonly parameterConfirmations: ParameterConfirmationRepository
  private readonly deleteDocumentCommand: DeleteNormativeDocument
  private readonly documentService: NormativeDocumentService
  private readonly pu66Imports: Pu66ImportService
  private readonly pu66Verifications: Pu66VerificationRepository
  readonly path: string
  private readonly now: () => string
  /** Версия схемы, с которой база обновлена при этом открытии; `null` — обновления не было. */
  readonly migratedFrom: number | null = null
  /** Имя копии в `backupDirectory`, снятой перед обновлением схемы; `null` — копия не создавалась. */
  readonly migrationBackup: string | null = null

  constructor(path: string, now: () => string = () => new Date().toISOString()) {
    this.path = path
    this.now = now
    this.db = openDatabase(path)
    try {
      const migration = migrateDatabase(this.db, { path, now: () => this.now() })
      this.migratedFrom = migration.migratedFrom
      this.migrationBackup = migration.migrationBackup
      this.projectSources = new ProjectSourceStore(this.db)
      this.projects = new ProjectRepository(this.db, this.projectSources, () => this.now())
      this.recovery = new RecoveryRepository(this.db, this.projectSources, () => this.now())
      this.legacy = new LegacyRegistryRepository(this.db, () => this.now())
      this.pu66Keys = new Pu66KeyResolver(this.db)
      this.pu66 = new Pu66Repository(this.db, this.pu66Keys)
      this.pu66Lifecycle = new Pu66LifecycleRepository(this.db, this.pu66Keys, () => this.now())
      this.pu66LifecycleService = new Pu66LifecycleService(
        this.pu66,
        this.pu66Lifecycle,
        new SqliteTransactionRunner(this.db),
        () => this.now(),
      )
      this.pu66Imports = new Pu66ImportService(
        new Pu66ImportRepository(
          this.db,
          (key) => this.pu66Lifecycle.getStatus(key),
          () => this.now(),
        ),
        this.pu66LifecycleService,
        this.pu66Lifecycle,
        new SqliteTransactionRunner(this.db),
      )
      this.pu66Verifications = new Pu66VerificationRepository(
        this.db,
        this.pu66Keys,
        (key) => this.pu66Lifecycle.getStatus(key),
        () => this.now(),
      )
      this.documents = new NormativeDocumentRepository(this.db, () => this.now())
      const signDocumentReferences = new SignCatalogDocumentReferences(this.db)
      this.documentService = new NormativeDocumentService(this.documents, (id) =>
        signDocumentReferences.countBatches(id),
      )
      this.documentText = new DocumentTextRepository(this.db)
      this.parameterConfirmations = new ParameterConfirmationRepository(this.db, () => this.now())
      this.deleteDocumentCommand = new DeleteNormativeDocument(
        this.documents,
        this.documentText,
        this.parameterConfirmations,
        signDocumentReferences,
        new SqliteTransactionRunner(this.db),
      )
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

  /** Версия схемы локальной базы (`PRAGMA user_version`) — для диагностики. */
  schemaVersion(): number {
    return readSchemaVersion(this.db)
  }

  listCrossings(): CrossingRecord[] {
    return this.legacy.listCrossings()
  }

  saveCrossing(draft: CrossingDraft, expectedRevision: number): CrossingRecord {
    return this.legacy.saveCrossing(draft, expectedRevision)
  }

  listNormative(): NormativeRecord[] {
    return this.legacy.listNormative()
  }

  saveNormative(draft: NormativeDraft, expectedRevision: number): NormativeRecord {
    return this.legacy.saveNormative(draft, expectedRevision)
  }

  listProjects(): ProjectSummary[] {
    return this.projects.list()
  }

  getProject(id: string): ProjectRecord | null {
    return this.projects.get(id)
  }

  listProjectRevisions(id: string): ProjectRevision[] {
    return this.projects.listRevisions(id)
  }

  getProjectRevision(id: string, revision: number): ProjectRecord | null {
    return this.projects.getRevision(id, revision)
  }

  saveProject(scheme: Scheme, expectedRevision: number, forceRevision = false): ProjectRecord {
    return this.projects.save(scheme, expectedRevision, forceRevision)
  }

  restoreProject(
    id: string,
    sourceRevision: number,
    expectedRevision: number,
  ): ProjectRecord | null {
    return this.projects.restore(id, sourceRevision, expectedRevision)
  }

  listRecoveries(): RecoverySummary[] {
    return this.recovery.list()
  }

  getRecovery(sessionId: string, access?: { ownerId?: string }): RecoveryRecord | null {
    return this.recovery.get(sessionId, access)
  }

  /** Compatibility guard; HTTP writes use saveRecovery as one atomic command. */
  assertRecoveryAvailable(sessionId: string, ownerId?: string): void {
    this.recovery.assertAvailable(sessionId, ownerId)
  }

  claimRecovery(sessionId: string, ownerId: string, expectedVersion: number): RecoveryRecord {
    return this.recovery.claim({ sessionId, ownerId, expectedVersion })
  }

  heartbeatRecovery(sessionId: string, ownerId: string): void {
    this.recovery.renew({ sessionId, ownerId })
  }

  releaseRecovery(sessionId: string, ownerId: string): void {
    this.recovery.release({ sessionId, ownerId })
  }

  /** Compatibility resolver; HTTP writes resolve sources inside saveRecovery. */
  resolveRecoveryScheme(sessionId: string, value: unknown, sourceSha256?: string): Scheme {
    return this.recovery.resolveScheme(sessionId, value, sourceSha256)
  }

  saveRecovery(input: RecoverySaveInput, ownerId: string, sourceSha256?: string): RecoveryRecord {
    return this.recovery.save({ input, ownerId, sourceSha256 })
  }

  deleteRecovery(sessionId: string, expectedVersion: number, ownerId?: string): void {
    this.recovery.delete({ sessionId, expectedVersion, ownerId })
  }

  getPu66Status(requestedKey: string): Pu66Status | null {
    return this.pu66Lifecycle.getStatus(requestedKey)
  }

  listPu66Lifecycle(requestedKey: string): Array<NonNullable<Pu66Status['event']>> | null {
    return this.pu66Lifecycle.list(requestedKey)
  }

  planPu66Lifecycle(raw: Pu66LifecycleWrite): Pu66LifecyclePlan {
    return this.pu66LifecycleService.plan(raw)
  }

  recordPu66Lifecycle(input: Pu66LifecycleWrite, expectedFingerprint: string): number {
    return this.pu66LifecycleService.record(input, expectedFingerprint)
  }

  planPu66(entries: Pu66Import[]) {
    return this.pu66Imports.plan(entries)
  }

  inspectPu66(entries: Pu66Import[]) {
    return this.pu66Imports.inspect(entries)
  }

  planPu66Import(entries: Pu66Import[], restoration: Pu66ImportRestore | null = null) {
    return this.pu66Imports.preview(entries, restoration)
  }

  importPu66(entries: Pu66Import[], restoration: Pu66ImportRestore | null = null) {
    return this.pu66Imports.record(entries, restoration)
  }

  listPu66(includeExcluded = false): Pu66Summary[] {
    return this.pu66.list(includeExcluded)
  }

  recordPu66Verification(
    requestedKey: string,
    input: Pu66VerificationWrite,
  ): Pu66Verification | null {
    return this.pu66Verifications.record(requestedKey, input)
  }

  listPu66Verifications(requestedKey: string): Pu66Verification[] | null {
    return this.pu66Verifications.list(requestedKey)
  }

  getPu66Scheme(requestedKey: string): Pu66Scheme | null {
    return this.pu66.getScheme(requestedKey)
  }

  getPu66Norms(requestedKey: string): Pu66Norms | null {
    return this.pu66.getNorms(requestedKey)
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
    kind: LegacyRegistryKind,
    key: string,
  ): { revision: number; payload: unknown; updatedAt: string }[] {
    return this.legacy.history(kind, key)
  }

  /** Каталог резервных копий: `backups/` рядом с файлом базы, в том числе заданным `TOD_DATABASE_PATH`. */
  get backupDirectory(): string {
    return databaseBackupDirectory(this.path)
  }

  listDocuments(): DocumentRecord[] {
    return this.documents.list()
  }

  getDocument(id: number): DocumentRecord | null {
    return this.documents.get(id)
  }

  getDocumentPdf(id: number): { filename: string; pdf: Uint8Array } | null {
    return this.documents.getPdf(id)
  }

  findDocumentBySha(sha256: string): DocumentRecord | null {
    return this.documents.findBySha(sha256)
  }

  addDocument(
    input: DocumentMeta,
    filename: string,
    pdf: Uint8Array,
    sha256: string,
  ): DocumentRecord {
    return this.documentService.add(input, filename, pdf, sha256)
  }

  updateDocument(id: number, input: DocumentMeta): DocumentRecord | null {
    return this.documentService.update(id, input)
  }

  deleteDocument(id: number): boolean {
    return this.deleteDocumentCommand.execute(id)
  }

  getDocumentText(id: number): string[] | null {
    return this.documentText.get(id)
  }

  saveDocumentText(id: number, pages: readonly string[]): void {
    this.documentText.save(id, pages)
  }

  listParameterConfirmations(): ParameterConfirmation[] {
    return this.parameterConfirmations.list()
  }

  addParameterConfirmation(input: Omit<ParameterConfirmation, 'id'>): ParameterConfirmation {
    return this.parameterConfirmations.add(input)
  }

  async createBackup(): Promise<string> {
    return createManualBackup(this.db, this.path, () => this.now())
  }

  close(): void {
    this.db.close()
  }
}
