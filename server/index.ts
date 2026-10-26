import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { SignImportCommands } from './signs/import-commands.ts'
import { DiagnosticsLog, routeOf } from './diagnostics.ts'
import { databaseIdentity } from './database-identity.ts'
import { RegistryStore, migrationNotice } from './store.ts'
import { RequestError } from './http/request-error.ts'
import { checkRequest } from './http/security.ts'
import { defaultStaticFiles, serveBuiltApp, type StaticFiles } from './http/static-files.ts'
import { parameterRejection, writeHttpError, type ParameterRejection } from './http/error-mapper.ts'

import { createSystemRoutes } from './http/routes/system.ts'
import { createDiagnosticRoutes } from './http/routes/diagnostics.ts'
import { createLegacyRoutes } from './http/routes/legacy.ts'
import { createProjectRoutes } from './http/routes/projects.ts'
import { createRecoveryRoutes } from './http/routes/recovery.ts'
import { createPu66Routes } from './http/routes/pu66.ts'
import { createSignRoutes } from './http/routes/signs.ts'
import { createDocumentRoutes } from './http/routes/documents.ts'
import {
  createNormativeParameterRoutes,
  type ParameterRouteContext,
} from './http/routes/normative-parameters.ts'

export { directoryFiles, type StaticFiles } from './http/static-files.ts'

export const DEFAULT_PORT = 4100
const port = DEFAULT_PORT

export function createRegistryServer(
  store: RegistryStore,
  listenPort = port,
  staticFiles: StaticFiles = defaultStaticFiles(),
  diagnostics: DiagnosticsLog = new DiagnosticsLog(null, { version: 'dev', mode: 'test' }),
  /** Отличает этот запуск программы от других: по нему проверяется отметка рядом с базой. */
  instanceId: string = randomUUID(),
) {
  const databaseId = databaseIdentity(store.path)
  // Temporary compatibility wiring; route groups receive only these operations.
  const projectRoutes = createProjectRoutes({
    list: () => store.listProjects(),
    get: (id) => store.getProject(id),
    listRevisions: (id) => store.listProjectRevisions(id),
    getRevision: (id, revision) => store.getProjectRevision(id, revision),
    save: (scheme, expectedRevision) => store.saveProject(scheme, expectedRevision),
    restore: (id, sourceRevision, expectedRevision) =>
      store.restoreProject(id, sourceRevision, expectedRevision),
  })
  const recoveryRoutes = createRecoveryRoutes({
    list: () => store.listRecoveries(),
    get: (id, access) => store.getRecovery(id, access),
    claim: ({ sessionId, ownerId, expectedVersion }) =>
      store.claimRecovery(sessionId, ownerId, expectedVersion),
    renew: ({ sessionId, ownerId }) => store.heartbeatRecovery(sessionId, ownerId),
    release: ({ sessionId, ownerId }) => store.releaseRecovery(sessionId, ownerId),
    save: ({ input, ownerId, sourceSha256 }) => store.saveRecovery(input, ownerId, sourceSha256),
    delete: ({ sessionId, expectedVersion, ownerId }) =>
      store.deleteRecovery(sessionId, expectedVersion, ownerId),
  })
  const pu66Routes = createPu66Routes({
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
      recordPu66Lifecycle: (input, fingerprint) => store.recordPu66Lifecycle(input, fingerprint),
      createBackup: () => store.createBackup(),
    },
    importCommands: {
      planPu66Import: (entries, restoration) => store.planPu66Import(entries, restoration),
      importPu66: (entries, restoration) => store.importPu66(entries, restoration),
      createBackup: () => store.createBackup(),
    },
  })
  const signImportCommands: SignImportCommands = {
    getDocument: (id) => store.getDocument(id),
    getDocumentPdf: (id) => store.getDocumentPdf(id),
    latestSignCatalog: () => store.latestSignCatalog(),
    planSigns: (entries, source) => store.planSigns(entries, source),
    importSigns: (entries, source) => store.importSigns(entries, source),
    createBackup: () => store.createBackup(),
  }
  const signRoutes = createSignRoutes({
    catalog: {
      list: (query, limit) => store.listSigns(query, limit),
      latest: () => store.latestSignCatalog(),
      getMetadata: (code, revision) => store.getSignMetadata(code, revision),
      getPng: (code, numbered, revision) => store.getSignPng(code, numbered, revision),
    },
    importCommands: signImportCommands,
  })
  const documentRoutes = createDocumentRoutes({
    documents: {
      list: () => store.listDocuments(),
      getPdf: (id) => store.getDocumentPdf(id),
      update: (id, meta) => store.updateDocument(id, meta),
      delete: (id) => store.deleteDocument(id),
    },
    importCommands: {
      listDocuments: () => store.listDocuments(),
      addDocument: (meta, filename, pdf, sha256) => store.addDocument(meta, filename, pdf, sha256),
      createBackup: () => store.createBackup(),
    },
    signImportCommands,
  })
  const normativeParameterRoutes = createNormativeParameterRoutes({
    listDocuments: () => store.listDocuments(),
    getDocument: (id) => store.getDocument(id),
    getDocumentPdf: (id) => store.getDocumentPdf(id),
    getDocumentText: (id) => store.getDocumentText(id),
    saveDocumentText: (id, pages) => store.saveDocumentText(id, pages),
    listParameterConfirmations: () => store.listParameterConfirmations(),
    addParameterConfirmation: (input) => store.addParameterConfirmation(input),
  })
  const systemRoutes = createSystemRoutes({
    databasePath: store.path,
    databaseId,
    instanceId,
    createBackup: () => store.createBackup(),
  })
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
  const diagnosticRoutes = createDiagnosticRoutes({
    report: () => diagnostics.report(diagnosticQueries),
    record: (event) => diagnostics.record(event),
    clear: () => diagnostics.clear(),
  })
  const legacyRoutes = createLegacyRoutes({
    listCrossings: () => store.listCrossings(),
    listNormative: () => store.listNormative(),
    saveCrossing: (draft, expectedRevision) => store.saveCrossing(draft, expectedRevision),
    saveNormative: (draft, expectedRevision) => store.saveNormative(draft, expectedRevision),
  })
  const server = createServer(async (req, res) => {
    const started = performance.now()
    let route = routeOf(req.method ?? 'GET', '/api/?')
    const parameterContext: ParameterRouteContext = {}
    let rejection: ParameterRejection | undefined
    res.on('finish', () => {
      if (route !== 'GET /api/diagnostics')
        diagnostics.request(route, res.statusCode, performance.now() - started, rejection)
    })
    try {
      const address = server.address()
      const actualPort = typeof address === 'object' && address ? address.port : listenPort
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${actualPort}`)
      const pathname = url.pathname
      route = routeOf(req.method ?? 'GET', pathname)
      checkRequest(req, actualPort)
      if (await projectRoutes(req, res, url)) return
      if (await recoveryRoutes(req, res, url)) return
      if (await pu66Routes(req, res, url)) return
      if (await signRoutes(req, res, url)) return
      if (await normativeParameterRoutes(req, res, url, parameterContext)) return
      if (await documentRoutes(req, res, url)) return
      if (await systemRoutes(req, res, url)) return
      if (await diagnosticRoutes(req, res, url)) return
      if (await legacyRoutes(req, res, url)) return
      if (req.method === 'GET' && !pathname.startsWith('/api/')) {
        await serveBuiltApp(pathname, res, staticFiles)
      } else {
        throw new RequestError(404, 'Адрес не найден.')
      }
    } catch (error) {
      rejection = parameterRejection(error, parameterContext.parameterId)
      writeHttpError(res, error, route, diagnostics)
    }
  })
  return server
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.umask(0o077)
  const databasePath =
    process.env.TOD_DATABASE_PATH ??
    fileURLToPath(new URL('../private-data/registry.sqlite', import.meta.url))
  const store = new RegistryStore(databasePath)
  const diagnostics = new DiagnosticsLog(join(dirname(databasePath), 'diagnostics.jsonl'), {
    version: 'dev',
    mode: 'npm run dev',
  })
  const server = createRegistryServer(store, port, undefined, diagnostics)
  server.listen(port, '127.0.0.1', () => {
    console.log(`Локальный редактор: http://127.0.0.1:${port}/`)
    console.log(`Реестр хранится в ${databasePath}`)
    const updated = migrationNotice(store)
    if (updated) console.log(updated)
  })
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => server.close(() => store.close()))
  }
}
