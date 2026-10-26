import { openDatabase } from './database/connection.ts'
import { migrateDatabase } from './database/migration-runner.ts'
import { ProjectSourceStore } from './projects/project-source-store.ts'
import { ProjectRepository } from './projects/project-repository.ts'
import { RecoveryRepository } from './recovery/recovery-repository.ts'
import { LegacyRegistryRepository } from './legacy/legacy-registry-repository.ts'
import { initialNormativeEntries } from './legacy/initial-normative-entries.ts'
import { Pu66KeyResolver } from './pu66/key-resolver.ts'
import { Pu66Repository } from './pu66/repository.ts'
import { Pu66LifecycleRepository } from './pu66/lifecycle-repository.ts'
import { Pu66LifecycleService } from './pu66/lifecycle-service.ts'
import { Pu66ImportRepository } from './pu66/import-repository.ts'
import { Pu66ImportService } from './pu66/import-service.ts'
import { Pu66VerificationRepository } from './pu66/verification-repository.ts'
import { SqliteTransactionRunner } from './database/transaction-runner.ts'
import { SignCatalogRepository } from './signs/catalog-repository.ts'
import { SignCatalogDocumentReferences } from './signs/document-references.ts'
import { NormativeDocumentRepository } from './documents/normative-document-repository.ts'
import { NormativeDocumentService } from './documents/normative-document-service.ts'
import { DocumentTextRepository } from './documents/document-text-repository.ts'
import { ParameterConfirmationRepository } from './parameters/confirmation-repository.ts'
import { DeleteNormativeDocument } from './documents/delete-normative-document.ts'

/** Assemble one server's adapters on one connection; close it if initialization fails.
 * The caller owns the returned connection after successful initialization.
 */
export function createServerServices(
  path: string,
  now: () => string = () => new Date().toISOString(),
) {
  const clock = () => now()
  const db = openDatabase(path)
  try {
    const migration = migrateDatabase(db, { path, now: clock })
    const projectSources = new ProjectSourceStore(db)
    const projects = new ProjectRepository(db, projectSources, clock)
    const recovery = new RecoveryRepository(db, projectSources, clock)
    const legacy = new LegacyRegistryRepository(db, clock)
    const pu66Keys = new Pu66KeyResolver(db)
    const pu66 = new Pu66Repository(db, pu66Keys)
    const pu66Lifecycle = new Pu66LifecycleRepository(db, pu66Keys, clock)
    const pu66LifecycleService = new Pu66LifecycleService(
      pu66,
      pu66Lifecycle,
      new SqliteTransactionRunner(db),
      clock,
    )
    const pu66Imports = new Pu66ImportService(
      new Pu66ImportRepository(db, (key) => pu66Lifecycle.getStatus(key), clock),
      pu66LifecycleService,
      pu66Lifecycle,
      new SqliteTransactionRunner(db),
    )
    const pu66Verifications = new Pu66VerificationRepository(
      db,
      pu66Keys,
      (key) => pu66Lifecycle.getStatus(key),
      clock,
    )
    const signCatalog = new SignCatalogRepository(db, clock)
    const documents = new NormativeDocumentRepository(db, clock)
    const signDocumentReferences = new SignCatalogDocumentReferences(db)
    const documentService = new NormativeDocumentService(documents, (id) =>
      signDocumentReferences.countBatches(id),
    )
    const documentText = new DocumentTextRepository(db)
    const parameterConfirmations = new ParameterConfirmationRepository(db, clock)
    const deleteDocumentCommand = new DeleteNormativeDocument(
      documents,
      documentText,
      parameterConfirmations,
      signDocumentReferences,
      new SqliteTransactionRunner(db),
    )
    if (legacy.listNormative().length === 0) {
      for (const entry of initialNormativeEntries) legacy.saveNormative(entry, 0)
    }
    return {
      db,
      migration,
      projects,
      recovery,
      legacy,
      pu66,
      pu66Lifecycle,
      pu66LifecycleService,
      pu66Imports,
      pu66Verifications,
      signCatalog,
      documents,
      documentService,
      documentText,
      parameterConfirmations,
      deleteDocumentCommand,
    }
  } catch (error) {
    // A failed multi-statement migration can leave a transaction open.
    try {
      db.exec('ROLLBACK')
    } catch {
      // No transaction was active.
    }
    db.close()
    throw error
  }
}

export type ServerServices = ReturnType<typeof createServerServices>
