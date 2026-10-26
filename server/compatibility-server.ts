import type { RegistryStore } from './store.ts'
import type { SignImportCommands } from './signs/import-commands.ts'
import type { DiagnosticsLog } from './diagnostics.ts'
import { createHttpServer, DEFAULT_PORT } from './http/server.ts'
import type { StaticFiles } from './http/static-files.ts'

/** Temporary adapter for callers still testing the facade; production uses ServerRuntime. */
export function createRegistryServer(
  store: RegistryStore,
  listenPort = DEFAULT_PORT,
  staticFiles?: StaticFiles,
  diagnostics?: DiagnosticsLog,
  instanceId?: string,
) {
  const signImportCommands: SignImportCommands = {
    getDocument: (id) => store.getDocument(id),
    getDocumentPdf: (id) => store.getDocumentPdf(id),
    latestSignCatalog: () => store.latestSignCatalog(),
    planSigns: (entries, source) => store.planSigns(entries, source),
    importSigns: (entries, source) => store.importSigns(entries, source),
    createBackup: () => store.createBackup(),
  }
  const diagnosticQueries = {
    path: store.path,
    backupDirectory: store.backupDirectory,
    schemaVersion: () => store.schemaVersion(),
    listPu66: () => store.listPu66(),
    listProjects: () => store.listProjects(),
    listRecoveries: () => store.listRecoveries(),
    listDocuments: () => store.listDocuments(),
    listParameterConfirmations: () => store.listParameterConfirmations(),
    latestSignCatalog: () => store.latestSignCatalog(),
  }
  return createHttpServer(
    {
      path: store.path,
      projects: {
        list: () => store.listProjects(),
        get: (id) => store.getProject(id),
        listRevisions: (id) => store.listProjectRevisions(id),
        getRevision: (id, revision) => store.getProjectRevision(id, revision),
        save: (scheme, expectedRevision) => store.saveProject(scheme, expectedRevision),
        restore: (id, sourceRevision, expectedRevision) =>
          store.restoreProject(id, sourceRevision, expectedRevision),
      },
      recovery: {
        list: () => store.listRecoveries(),
        get: (id, access) => store.getRecovery(id, access),
        claim: ({ sessionId, ownerId, expectedVersion }) =>
          store.claimRecovery(sessionId, ownerId, expectedVersion),
        renew: ({ sessionId, ownerId }) => store.heartbeatRecovery(sessionId, ownerId),
        release: ({ sessionId, ownerId }) => store.releaseRecovery(sessionId, ownerId),
        save: ({ input, ownerId, sourceSha256 }) =>
          store.saveRecovery(input, ownerId, sourceSha256),
        delete: ({ sessionId, expectedVersion, ownerId }) =>
          store.deleteRecovery(sessionId, expectedVersion, ownerId),
      },
      pu66: {
        cards: {
          list: (includeExcluded) => store.listPu66(includeExcluded),
          getNorms: (key) => store.getPu66Norms(key),
          getScheme: (key) => store.getPu66Scheme(key),
        },
        lifecycle: {
          getStatus: (key) => store.getPu66Status(key),
          list: (key) => store.listPu66Lifecycle(key),
        },
        verifications: {
          list: (key) => store.listPu66Verifications(key),
          record: (key, input) => store.recordPu66Verification(key, input),
        },
        lifecycleCommands: {
          planPu66Lifecycle: (input) => store.planPu66Lifecycle(input),
          recordPu66Lifecycle: (input, fingerprint) =>
            store.recordPu66Lifecycle(input, fingerprint),
          createBackup: () => store.createBackup(),
        },
        importCommands: {
          planPu66Import: (entries, restoration) => store.planPu66Import(entries, restoration),
          importPu66: (entries, restoration) => store.importPu66(entries, restoration),
          createBackup: () => store.createBackup(),
        },
      },
      signs: {
        catalog: {
          list: (query, limit) => store.listSigns(query, limit),
          latest: () => store.latestSignCatalog(),
          getMetadata: (code, revision) => store.getSignMetadata(code, revision),
          getPng: (code, numbered, revision) => store.getSignPng(code, numbered, revision),
        },
        importCommands: signImportCommands,
      },
      documents: {
        documents: {
          list: () => store.listDocuments(),
          getPdf: (id) => store.getDocumentPdf(id),
          update: (id, meta) => store.updateDocument(id, meta),
          delete: (id) => store.deleteDocument(id),
        },
        importCommands: {
          listDocuments: () => store.listDocuments(),
          addDocument: (meta, filename, pdf, sha256) =>
            store.addDocument(meta, filename, pdf, sha256),
          createBackup: () => store.createBackup(),
        },
        signImportCommands,
      },
      parameters: {
        listDocuments: () => store.listDocuments(),
        getDocument: (id) => store.getDocument(id),
        getDocumentPdf: (id) => store.getDocumentPdf(id),
        getDocumentText: (id) => store.getDocumentText(id),
        saveDocumentText: (id, pages) => store.saveDocumentText(id, pages),
        listParameterConfirmations: () => store.listParameterConfirmations(),
        addParameterConfirmation: (input) => store.addParameterConfirmation(input),
      },
      legacy: {
        listCrossings: () => store.listCrossings(),
        listNormative: () => store.listNormative(),
        saveCrossing: (draft, expectedRevision) => store.saveCrossing(draft, expectedRevision),
        saveNormative: (draft, expectedRevision) => store.saveNormative(draft, expectedRevision),
      },
      diagnostics: diagnosticQueries,
      createBackup: () => store.createBackup(),
    },
    listenPort,
    staticFiles,
    diagnostics,
    instanceId,
  )
}
