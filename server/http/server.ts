import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { databaseIdentity } from '../database-identity.ts'
import { DiagnosticsLog, routeOf } from '../diagnostics.ts'
import type { DiagnosticDatabaseQueries } from '../diagnostic-database.ts'
import type { NormativeParameterStorage } from '../normative-parameters.ts'
import { RequestError } from './request-error.ts'
import { checkRequest } from './security.ts'
import { defaultStaticFiles, serveBuiltApp, type StaticFiles } from './static-files.ts'
import { parameterRejection, writeHttpError, type ParameterRejection } from './error-mapper.ts'
import { createProjectRoutes, type ProjectRouteStorage } from './routes/projects.ts'
import { createRecoveryRoutes, type RecoveryRouteStorage } from './routes/recovery.ts'
import { createPu66Routes, type Pu66RouteDependencies } from './routes/pu66.ts'
import { createSignRoutes, type SignRouteDependencies } from './routes/signs.ts'
import { createDocumentRoutes, type DocumentRouteDependencies } from './routes/documents.ts'
import {
  createNormativeParameterRoutes,
  type ParameterRouteContext,
} from './routes/normative-parameters.ts'
import { createSystemRoutes } from './routes/system.ts'
import { createDiagnosticRoutes } from './routes/diagnostics.ts'
import { createLegacyRoutes, type LegacyRouteStorage } from './routes/legacy.ts'

export const DEFAULT_PORT = 4100
export interface HttpServerDependencies {
  path: string
  projects: ProjectRouteStorage
  recovery: RecoveryRouteStorage
  pu66: Pu66RouteDependencies
  signs: SignRouteDependencies
  documents: DocumentRouteDependencies
  parameters: NormativeParameterStorage
  diagnostics: DiagnosticDatabaseQueries
  legacy: LegacyRouteStorage
  createBackup(): Promise<string>
}

/** Own HTTP handling only; the caller owns database and listening/shutdown. */
export function createHttpServer(
  dependencies: HttpServerDependencies,
  listenPort = DEFAULT_PORT,
  staticFiles: StaticFiles = defaultStaticFiles(),
  diagnostics = new DiagnosticsLog(null, { version: 'dev', mode: 'test' }),
  instanceId: string = randomUUID(),
) {
  const databaseId = databaseIdentity(dependencies.path)
  const projectRoutes = createProjectRoutes(dependencies.projects)
  const recoveryRoutes = createRecoveryRoutes(dependencies.recovery)
  const pu66Routes = createPu66Routes(dependencies.pu66)
  const signRoutes = createSignRoutes(dependencies.signs)
  const documentRoutes = createDocumentRoutes(dependencies.documents)
  const normativeParameterRoutes = createNormativeParameterRoutes(dependencies.parameters)
  const systemRoutes = createSystemRoutes({
    databasePath: dependencies.path,
    databaseId,
    instanceId,
    createBackup: () => dependencies.createBackup(),
  })
  const diagnosticRoutes = createDiagnosticRoutes({
    report: () => diagnostics.report(dependencies.diagnostics),
    record: (event) => diagnostics.record(event),
    clear: () => diagnostics.clear(),
  })
  const legacyRoutes = createLegacyRoutes(dependencies.legacy)
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
