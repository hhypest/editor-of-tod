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
  SignCatalogRepository,
  type SignCatalogSource,
  type SignCatalogPlan,
} from './signs/catalog-repository.ts'
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

export type { SignCatalogSource, SignCatalogPlan } from './signs/catalog-repository.ts'

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
  private readonly signCatalog: SignCatalogRepository
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
      this.signCatalog = new SignCatalogRepository(this.db, () => this.now())
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

  latestSignCatalog() {
    return this.signCatalog.latest()
  }

  planSigns(entries: SignImport[], source?: SignCatalogSource): SignCatalogPlan {
    return this.signCatalog.plan(entries, source)
  }

  importSigns(entries: SignImport[], source?: SignCatalogSource): SignCatalogPlan {
    return this.signCatalog.import(entries, source)
  }

  listSigns(query = '', limit = 100) {
    return this.signCatalog.list(query, limit)
  }

  getSignMetadata(code: string, revision: number) {
    return this.signCatalog.getMetadata(code, revision)
  }

  getSignPng(code: string, numbered: boolean, revision?: number): Uint8Array | null {
    return this.signCatalog.getPng(code, numbered, revision)
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
