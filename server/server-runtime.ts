import { createServerServices } from './composition-root.ts'
import { databaseBackupDirectory, createManualBackup } from './database/backups.ts'
import { readSchemaVersion } from './database/schema-version.ts'
import type { HttpServerDependencies } from './http/server.ts'
import type { ImportCliStorage } from './import-commands.ts'
import type { SignImportCommands } from './signs/import-commands.ts'

/** Composition root for production consumers on one caller-owned connection. */
export function createServerRuntime(
  path: string,
  now: () => string = () => new Date().toISOString(),
) {
  const clock = () => now()
  const services = createServerServices(path, clock)
  const {
    db,
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
  } = services
  const backupDirectory = databaseBackupDirectory(path)
  const createBackup = () => createManualBackup(db, path, clock)
  const schemaVersion = () => readSchemaVersion(db)
  const signImportCommands: SignImportCommands = {
    getDocument: (id) => documents.get(id),
    getDocumentPdf: (id) => documents.getPdf(id),
    latestSignCatalog: () => signCatalog.latest(),
    planSigns: (entries, source) => signCatalog.plan(entries, source),
    importSigns: (entries, source) => signCatalog.import(entries, source),
    createBackup,
  }
  const http: HttpServerDependencies = {
    path,
    projects,
    recovery,
    legacy,
    createBackup,
    pu66: {
      cards: pu66,
      lifecycle: pu66Lifecycle,
      verifications: pu66Verifications,
      lifecycleCommands: {
        planPu66Lifecycle: (input) => pu66LifecycleService.plan(input),
        recordPu66Lifecycle: (input, fingerprint) =>
          pu66LifecycleService.record(input, fingerprint),
        createBackup,
      },
      importCommands: {
        planPu66Import: (entries, restoration) => pu66Imports.preview(entries, restoration),
        importPu66: (entries, restoration) => pu66Imports.record(entries, restoration),
        createBackup,
      },
    },
    signs: { catalog: signCatalog, importCommands: signImportCommands },
    documents: {
      documents: {
        list: () => documents.list(),
        getPdf: (id) => documents.getPdf(id),
        update: (id, meta) => documentService.update(id, meta),
        delete: (id) => deleteDocumentCommand.execute(id),
      },
      importCommands: {
        listDocuments: () => documents.list(),
        addDocument: (meta, filename, pdf, sha256) =>
          documentService.add(meta, filename, pdf, sha256),
        createBackup,
      },
      signImportCommands,
    },
    parameters: {
      listDocuments: () => documents.list(),
      getDocument: (id) => documents.get(id),
      getDocumentPdf: (id) => documents.getPdf(id),
      getDocumentText: (id) => documentText.get(id),
      saveDocumentText: (id, pages) => documentText.save(id, pages),
      listParameterConfirmations: () => parameterConfirmations.list(),
      addParameterConfirmation: (input) => parameterConfirmations.add(input),
    },
    diagnostics: {
      path,
      backupDirectory,
      schemaVersion,
      listPu66: () => pu66.list(),
      listProjects: () => projects.list(),
      listRecoveries: () => recovery.list(),
      listDocuments: () => documents.list(),
      listParameterConfirmations: () => parameterConfirmations.list(),
      latestSignCatalog: () => signCatalog.latest(),
    },
  }
  const imports: ImportCliStorage = {
    backupDirectory,
    createBackup,
    planPu66: (entries) => pu66Imports.plan(entries),
    importPu66: (entries, restoration) => pu66Imports.record(entries, restoration),
    planSigns: (entries, source) => signCatalog.plan(entries, source),
    importSigns: (entries, source) => signCatalog.import(entries, source),
  }
  return {
    path,
    backupDirectory,
    ...services.migration,
    schemaVersion,
    http,
    imports,
    close: () => db.close(),
  }
}

export type ServerRuntime = ReturnType<typeof createServerRuntime>
