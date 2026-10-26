import { createServerServices, type ServerServices } from './composition-root.ts'
import type { DatabaseSync } from 'node:sqlite'
import { SCHEMA_VERSION, readSchemaVersion } from './database/schema-version.ts'
import { databaseBackupDirectory, createManualBackup } from './database/backups.ts'
import type { LegacyRegistryKind } from './legacy/legacy-registry-repository.ts'
import type { RecoverySaveInput } from './recovery/recovery-repository.ts'
import { RevisionConflict, ProjectTooLarge, RecoveryOwned } from './storage-errors.ts'
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
import { type Pu66Summary, type Pu66Scheme, type Pu66Norms } from './pu66/repository.ts'
import { AmbiguousPu66Key, InvalidPu66Lifecycle, InvalidPu66Verification } from './pu66/errors.ts'
import { type SignImport } from './signs.ts'
import { type SignCatalogSource, type SignCatalogPlan } from './signs/catalog-repository.ts'
import {
  type Pu66LifecyclePlan,
  type Pu66LifecycleWrite,
  type Pu66Status,
  type Pu66ImportRestore,
} from '../src/domain/pu66-lifecycle.ts'
import type { DocumentMeta, DocumentRecord } from '../src/domain/normative-documents.ts'

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

export { migrationNotice } from './database/migration-notice.ts'

export class RegistryStore {
  private readonly db: DatabaseSync
  private readonly services: ServerServices
  readonly path: string
  private readonly now: () => string
  /** Версия схемы, с которой база обновлена при этом открытии; `null` — обновления не было. */
  readonly migratedFrom: number | null = null
  /** Имя копии в `backupDirectory`, снятой перед обновлением схемы; `null` — копия не создавалась. */
  readonly migrationBackup: string | null = null

  constructor(path: string, now: () => string = () => new Date().toISOString()) {
    this.path = path
    this.now = now
    this.services = createServerServices(path, () => this.now())
    this.db = this.services.db
    this.migratedFrom = this.services.migration.migratedFrom
    this.migrationBackup = this.services.migration.migrationBackup
  }

  /** Версия схемы локальной базы (`PRAGMA user_version`) — для диагностики. */
  schemaVersion(): number {
    return readSchemaVersion(this.db)
  }

  listCrossings(): CrossingRecord[] {
    return this.services.legacy.listCrossings()
  }

  saveCrossing(draft: CrossingDraft, expectedRevision: number): CrossingRecord {
    return this.services.legacy.saveCrossing(draft, expectedRevision)
  }

  listNormative(): NormativeRecord[] {
    return this.services.legacy.listNormative()
  }

  saveNormative(draft: NormativeDraft, expectedRevision: number): NormativeRecord {
    return this.services.legacy.saveNormative(draft, expectedRevision)
  }

  listProjects(): ProjectSummary[] {
    return this.services.projects.list()
  }

  getProject(id: string): ProjectRecord | null {
    return this.services.projects.get(id)
  }

  listProjectRevisions(id: string): ProjectRevision[] {
    return this.services.projects.listRevisions(id)
  }

  getProjectRevision(id: string, revision: number): ProjectRecord | null {
    return this.services.projects.getRevision(id, revision)
  }

  saveProject(scheme: Scheme, expectedRevision: number, forceRevision = false): ProjectRecord {
    return this.services.projects.save(scheme, expectedRevision, forceRevision)
  }

  restoreProject(
    id: string,
    sourceRevision: number,
    expectedRevision: number,
  ): ProjectRecord | null {
    return this.services.projects.restore(id, sourceRevision, expectedRevision)
  }

  listRecoveries(): RecoverySummary[] {
    return this.services.recovery.list()
  }

  getRecovery(sessionId: string, access?: { ownerId?: string }): RecoveryRecord | null {
    return this.services.recovery.get(sessionId, access)
  }

  /** Compatibility guard; HTTP writes use saveRecovery as one atomic command. */
  assertRecoveryAvailable(sessionId: string, ownerId?: string): void {
    this.services.recovery.assertAvailable(sessionId, ownerId)
  }

  claimRecovery(sessionId: string, ownerId: string, expectedVersion: number): RecoveryRecord {
    return this.services.recovery.claim({ sessionId, ownerId, expectedVersion })
  }

  heartbeatRecovery(sessionId: string, ownerId: string): void {
    this.services.recovery.renew({ sessionId, ownerId })
  }

  releaseRecovery(sessionId: string, ownerId: string): void {
    this.services.recovery.release({ sessionId, ownerId })
  }

  /** Compatibility resolver; HTTP writes resolve sources inside saveRecovery. */
  resolveRecoveryScheme(sessionId: string, value: unknown, sourceSha256?: string): Scheme {
    return this.services.recovery.resolveScheme(sessionId, value, sourceSha256)
  }

  saveRecovery(input: RecoverySaveInput, ownerId: string, sourceSha256?: string): RecoveryRecord {
    return this.services.recovery.save({ input, ownerId, sourceSha256 })
  }

  deleteRecovery(sessionId: string, expectedVersion: number, ownerId?: string): void {
    this.services.recovery.delete({ sessionId, expectedVersion, ownerId })
  }

  getPu66Status(requestedKey: string): Pu66Status | null {
    return this.services.pu66Lifecycle.getStatus(requestedKey)
  }

  listPu66Lifecycle(requestedKey: string): Array<NonNullable<Pu66Status['event']>> | null {
    return this.services.pu66Lifecycle.list(requestedKey)
  }

  planPu66Lifecycle(raw: Pu66LifecycleWrite): Pu66LifecyclePlan {
    return this.services.pu66LifecycleService.plan(raw)
  }

  recordPu66Lifecycle(input: Pu66LifecycleWrite, expectedFingerprint: string): number {
    return this.services.pu66LifecycleService.record(input, expectedFingerprint)
  }

  planPu66(entries: Pu66Import[]) {
    return this.services.pu66Imports.plan(entries)
  }

  inspectPu66(entries: Pu66Import[]) {
    return this.services.pu66Imports.inspect(entries)
  }

  planPu66Import(entries: Pu66Import[], restoration: Pu66ImportRestore | null = null) {
    return this.services.pu66Imports.preview(entries, restoration)
  }

  importPu66(entries: Pu66Import[], restoration: Pu66ImportRestore | null = null) {
    return this.services.pu66Imports.record(entries, restoration)
  }

  listPu66(includeExcluded = false): Pu66Summary[] {
    return this.services.pu66.list(includeExcluded)
  }

  recordPu66Verification(
    requestedKey: string,
    input: Pu66VerificationWrite,
  ): Pu66Verification | null {
    return this.services.pu66Verifications.record(requestedKey, input)
  }

  listPu66Verifications(requestedKey: string): Pu66Verification[] | null {
    return this.services.pu66Verifications.list(requestedKey)
  }

  getPu66Scheme(requestedKey: string): Pu66Scheme | null {
    return this.services.pu66.getScheme(requestedKey)
  }

  getPu66Norms(requestedKey: string): Pu66Norms | null {
    return this.services.pu66.getNorms(requestedKey)
  }

  latestSignCatalog() {
    return this.services.signCatalog.latest()
  }

  planSigns(entries: SignImport[], source?: SignCatalogSource): SignCatalogPlan {
    return this.services.signCatalog.plan(entries, source)
  }

  importSigns(entries: SignImport[], source?: SignCatalogSource): SignCatalogPlan {
    return this.services.signCatalog.import(entries, source)
  }

  listSigns(query = '', limit = 100) {
    return this.services.signCatalog.list(query, limit)
  }

  getSignMetadata(code: string, revision: number) {
    return this.services.signCatalog.getMetadata(code, revision)
  }

  getSignPng(code: string, numbered: boolean, revision?: number): Uint8Array | null {
    return this.services.signCatalog.getPng(code, numbered, revision)
  }

  history(
    kind: LegacyRegistryKind,
    key: string,
  ): { revision: number; payload: unknown; updatedAt: string }[] {
    return this.services.legacy.history(kind, key)
  }

  /** Каталог резервных копий: `backups/` рядом с файлом базы, в том числе заданным `TOD_DATABASE_PATH`. */
  get backupDirectory(): string {
    return databaseBackupDirectory(this.path)
  }

  listDocuments(): DocumentRecord[] {
    return this.services.documents.list()
  }

  getDocument(id: number): DocumentRecord | null {
    return this.services.documents.get(id)
  }

  getDocumentPdf(id: number): { filename: string; pdf: Uint8Array } | null {
    return this.services.documents.getPdf(id)
  }

  findDocumentBySha(sha256: string): DocumentRecord | null {
    return this.services.documents.findBySha(sha256)
  }

  addDocument(
    input: DocumentMeta,
    filename: string,
    pdf: Uint8Array,
    sha256: string,
  ): DocumentRecord {
    return this.services.documentService.add(input, filename, pdf, sha256)
  }

  updateDocument(id: number, input: DocumentMeta): DocumentRecord | null {
    return this.services.documentService.update(id, input)
  }

  deleteDocument(id: number): boolean {
    return this.services.deleteDocumentCommand.execute(id)
  }

  getDocumentText(id: number): string[] | null {
    return this.services.documentText.get(id)
  }

  saveDocumentText(id: number, pages: readonly string[]): void {
    this.services.documentText.save(id, pages)
  }

  listParameterConfirmations(): ParameterConfirmation[] {
    return this.services.parameterConfirmations.list()
  }

  addParameterConfirmation(input: Omit<ParameterConfirmation, 'id'>): ParameterConfirmation {
    return this.services.parameterConfirmations.add(input)
  }

  async createBackup(): Promise<string> {
    return createManualBackup(this.db, this.path, () => this.now())
  }

  close(): void {
    this.db.close()
  }
}
