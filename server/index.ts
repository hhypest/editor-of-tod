import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { crossingWriteSchema, normativeWriteSchema } from '../src/domain/registry.ts'
import { pu66VerificationWriteSchema } from '../src/domain/pu66-review.ts'
import { pu66LifecycleWriteSchema } from '../src/domain/pu66-lifecycle.ts'
import { applyPu66Lifecycle } from './pu66-lifecycle.ts'
import { applyPu66Upload, previewPu66Upload, PU66_UPLOAD_REQUEST_BYTES } from './pu66-web-import.ts'
import { applySignUpload, previewSignUpload, SIGN_UPLOAD_REQUEST_BYTES } from './sign-web-import.ts'
import {
  applyDocumentUpload,
  DOCUMENT_UPLOAD_REQUEST_BYTES,
  identifyDocumentUpload,
  previewDocumentUpload,
} from './document-web-import.ts'
import { applyPdfSigns, pdfSignImage, previewPdfSigns } from './sign-pdf-import.ts'
import { confirmParameter, listParameterStates } from './normative-parameters.ts'
import { documentMetaSchema } from '../src/domain/normative-documents.ts'
import { clientEventsSchema, DiagnosticsLog, routeOf } from './diagnostics.ts'
import { databaseIdentity } from './database-identity.ts'
import { RegistryStore, migrationNotice } from './store.ts'
import { InvalidPu66Lifecycle } from './pu66/errors.ts'
import { RequestError } from './http/request-error.ts'
import { json, readJson } from './http/json.ts'
import { checkRequest } from './http/security.ts'
import { decodeKey } from './http/path.ts'
import { defaultStaticFiles, serveBuiltApp, type StaticFiles } from './http/static-files.ts'
import { sendPdf, sendPng, sendCachedPng } from './http/binary.ts'
import { parameterRejection, writeHttpError, type ParameterRejection } from './http/error-mapper.ts'

import { createProjectRoutes } from './http/routes/projects.ts'
import { createRecoveryRoutes } from './http/routes/recovery.ts'

export { directoryFiles, type StaticFiles } from './http/static-files.ts'

export const DEFAULT_PORT = 4100
const PROBE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
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
  const server = createServer(async (req, res) => {
    const started = performance.now()
    let route = routeOf(req.method ?? 'GET', '/api/?')
    let parameterId: string | undefined
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
      const documentPath =
        /^\/api\/documents\/(\d+)(\/pdf|\/signs\/preview|\/signs\/apply|\/signs\/image)?$/.exec(
          pathname,
        )
      if (req.method === 'GET' && pathname === '/api/status') {
        // Другой запуск программы кладёт рядом со своей базой пустой файл и спрашивает, видим
        // ли мы его рядом с нашей: так он узнаёт, что база та же, каким бы путём её ни открыли.
        const probe = url.searchParams.get('probe')
        const sameFile =
          probe !== null && PROBE_ID.test(probe) && store.path !== ':memory:'
            ? { probe: existsSync(`${store.path}.probe-${probe}`) }
            : {}
        json(res, 200, {
          application: 'editor-of-tod',
          ready: true,
          databaseId,
          instanceId,
          ...sameFile,
        })
      } else if (req.method === 'GET' && pathname === '/api/diagnostics') {
        json(res, 200, diagnostics.report(store))
      } else if (req.method === 'POST' && pathname === '/api/diagnostics/events') {
        const { events } = clientEventsSchema.parse(await readJson(req))
        for (const event of events) diagnostics.record({ source: 'client', ...event })
        json(res, 200, { recorded: events.length })
      } else if (req.method === 'POST' && pathname === '/api/diagnostics/clear') {
        diagnostics.clear()
        json(res, 200, { cleared: true })
      } else if (req.method === 'GET' && pathname === '/api/crossings') {
        json(res, 200, store.listCrossings())
      } else if (req.method === 'GET' && pathname === '/api/normative') {
        json(res, 200, store.listNormative())
      } else if (req.method === 'GET' && pathname === '/api/pu66') {
        json(res, 200, store.listPu66())
      } else if (req.method === 'GET' && pathname === '/api/pu66/lifecycle') {
        json(
          res,
          200,
          store.listPu66(true).map((card) => ({
            ...card,
            status: store.getPu66Status(card.referenceId),
          })),
        )
      } else if (req.method === 'POST' && pathname === '/api/pu66/lifecycle/preview') {
        json(res, 200, store.planPu66Lifecycle(pu66LifecycleWriteSchema.parse(await readJson(req))))
      } else if (req.method === 'POST' && pathname === '/api/pu66/lifecycle/apply') {
        json(res, 200, await applyPu66Lifecycle(store, await readJson(req)))
      } else if (req.method === 'GET' && /^\/api\/pu66\/[^/]+\/status$/.test(pathname)) {
        const key = decodeKey(pathname.slice('/api/pu66/'.length, -'/status'.length))
        json(res, 200, store.getPu66Status(key))
      } else if (req.method === 'GET' && /^\/api\/pu66\/[^/]+\/lifecycle$/.test(pathname)) {
        const key = decodeKey(pathname.slice('/api/pu66/'.length, -'/lifecycle'.length))
        const history = store.listPu66Lifecycle(key)
        if (!history) throw new RequestError(404, 'Карточка ПУ-66 не найдена.')
        json(res, 200, history)
      } else if (req.method === 'POST' && pathname === '/api/pu66/import/preview') {
        json(
          res,
          200,
          await previewPu66Upload(store, await readJson(req, PU66_UPLOAD_REQUEST_BYTES)),
        )
      } else if (req.method === 'POST' && pathname === '/api/pu66/import/apply') {
        json(res, 200, await applyPu66Upload(store, await readJson(req, PU66_UPLOAD_REQUEST_BYTES)))
      } else if (
        req.method === 'GET' &&
        pathname.startsWith('/api/pu66/') &&
        pathname.endsWith('/norms')
      ) {
        const key = decodeKey(pathname.slice('/api/pu66/'.length, -'/norms'.length))
        const norms = store.getPu66Norms(key)
        if (!norms) throw new RequestError(404, 'Карточка ПУ-66 не найдена.')
        json(res, 200, norms)
      } else if (
        req.method === 'GET' &&
        pathname.startsWith('/api/pu66/') &&
        pathname.endsWith('/scheme')
      ) {
        const encodedKey = pathname.slice('/api/pu66/'.length, -'/scheme'.length)
        const key = decodeKey(encodedKey)
        if (store.getPu66Status(key)?.excluded)
          throw new InvalidPu66Lifecycle('Карточка ПУ-66 исключена. Выберите действующую карточку.')
        const fields = store.getPu66Scheme(key)
        if (!fields) throw new RequestError(404, 'Карточка ПУ-66 не найдена.')
        json(res, 200, fields)
      } else if (
        req.method === 'GET' &&
        pathname.startsWith('/api/pu66/') &&
        pathname.endsWith('/verifications')
      ) {
        const key = decodeKey(pathname.slice('/api/pu66/'.length, -'/verifications'.length))
        const history = store.listPu66Verifications(key)
        if (!history) throw new RequestError(404, 'Карточка ПУ-66 не найдена.')
        json(res, 200, history)
      } else if (
        req.method === 'POST' &&
        pathname.startsWith('/api/pu66/') &&
        pathname.endsWith('/verification')
      ) {
        const key = decodeKey(pathname.slice('/api/pu66/'.length, -'/verification'.length))
        const input = pu66VerificationWriteSchema.parse(await readJson(req))
        const verification = store.recordPu66Verification(key, input)
        if (!verification) throw new RequestError(404, 'Карточка ПУ-66 не найдена.')
        json(res, 201, verification)
      } else if (req.method === 'GET' && pathname === '/api/signs') {
        const query =
          new URL(req.url ?? '/', `http://127.0.0.1:${actualPort}`).searchParams.get('query') ?? ''
        if (query.length > 80) throw new RequestError(400, 'Поиск слишком длинный.')
        json(res, 200, store.listSigns(query, 2_000))
      } else if (req.method === 'GET' && pathname === '/api/signs/catalog') {
        json(res, 200, store.latestSignCatalog())
      } else if (req.method === 'POST' && pathname === '/api/signs/import/preview') {
        json(res, 200, previewSignUpload(store, await readJson(req, SIGN_UPLOAD_REQUEST_BYTES)))
      } else if (req.method === 'POST' && pathname === '/api/signs/import/apply') {
        json(res, 200, await applySignUpload(store, await readJson(req, SIGN_UPLOAD_REQUEST_BYTES)))
      } else if (req.method === 'GET' && pathname === '/api/normative-parameters') {
        json(res, 200, await listParameterStates(store))
      } else if (
        req.method === 'POST' &&
        /^\/api\/normative-parameters\/[a-z0-9-]{1,80}\/confirm$/.test(pathname)
      ) {
        const id = pathname.split('/')[3]!
        parameterId = id
        json(res, 200, await confirmParameter(store, id, await readJson(req)))
      } else if (req.method === 'GET' && pathname === '/api/documents') {
        json(res, 200, store.listDocuments())
      } else if (req.method === 'POST' && pathname === '/api/documents/identify') {
        json(
          res,
          200,
          await identifyDocumentUpload(await readJson(req, DOCUMENT_UPLOAD_REQUEST_BYTES)),
        )
      } else if (req.method === 'POST' && pathname === '/api/documents/preview') {
        json(
          res,
          200,
          previewDocumentUpload(store, await readJson(req, DOCUMENT_UPLOAD_REQUEST_BYTES)),
        )
      } else if (req.method === 'POST' && pathname === '/api/documents/apply') {
        json(
          res,
          201,
          await applyDocumentUpload(store, await readJson(req, DOCUMENT_UPLOAD_REQUEST_BYTES)),
        )
      } else if (documentPath) {
        const id = Number(documentPath[1])
        if (!Number.isSafeInteger(id)) throw new RequestError(400, 'Неверный номер документа.')
        if (req.method === 'GET' && documentPath[2] === '/pdf') {
          const file = store.getDocumentPdf(id)
          if (!file) throw new RequestError(404, 'Документ не найден.')
          sendPdf(res, file)
        } else if (req.method === 'POST' && documentPath[2] === '/signs/preview') {
          json(res, 200, await previewPdfSigns(store, id, await readJson(req)))
        } else if (req.method === 'POST' && documentPath[2] === '/signs/apply') {
          json(res, 200, await applyPdfSigns(store, id, await readJson(req)))
        } else if (req.method === 'GET' && documentPath[2] === '/signs/image') {
          const params = new URL(req.url ?? '/', `http://127.0.0.1:${actualPort}`).searchParams
          const key = params.get('key') ?? ''
          if (!/^\d{1,4}-\d{1,4}(\.\d{1,2})?$/.test(key))
            throw new RequestError(400, 'Неверный номер изображения.')
          const png = await pdfSignImage(store, id, key, params.get('yellow') === '1')
          sendPng(res, png)
        } else if (req.method === 'PUT' && !documentPath[2]) {
          const updated = store.updateDocument(id, documentMetaSchema.parse(await readJson(req)))
          if (!updated) throw new RequestError(404, 'Документ не найден.')
          json(res, 200, updated)
        } else if (req.method === 'DELETE' && !documentPath[2]) {
          if (!store.deleteDocument(id)) throw new RequestError(404, 'Документ не найден.')
          json(res, 200, { deleted: id })
        } else throw new RequestError(405, 'Метод не поддерживается.')
      } else if (req.method === 'GET' && /^\/api\/signs\/[^/]+\/metadata$/.test(pathname)) {
        const code = decodeKey(pathname.slice('/api/signs/'.length, -'/metadata'.length))
        if (!/^[0-9][0-9A-Za-z._-]*ж?$/.test(code))
          throw new RequestError(400, 'Неверный код знака.')
        const rev = new URL(req.url ?? '/', `http://127.0.0.1:${actualPort}`).searchParams.get(
          'rev',
        )
        if (rev === null || !/^[1-9]\d*$/.test(rev) || !Number.isSafeInteger(Number(rev)))
          throw new RequestError(400, 'Укажите версию изображения знака.')
        const metadata = store.getSignMetadata(code, Number(rev))
        if (!metadata)
          throw new RequestError(404, 'Версия изображения знака не найдена. Обновите каталог.')
        json(res, 200, metadata)
      } else if (req.method === 'GET' && /^\/api\/signs\/[^/]+\/image$/.test(pathname)) {
        const code = decodeKey(pathname.slice('/api/signs/'.length, -'/image'.length))
        if (!/^[0-9][0-9A-Za-z._-]*ж?$/.test(code))
          throw new RequestError(400, 'Неверный код знака.')
        const params = new URL(req.url ?? '/', `http://127.0.0.1:${actualPort}`).searchParams
        const format = params.get('format')
        if (format && format !== 'png')
          throw new RequestError(400, 'Изображения знаков доступны только в PNG.')
        const numbered = params.get('numbered') === '1'
        const rev = params.get('rev')
        if (rev !== null && (!/^[1-9]\d*$/.test(rev) || !Number.isSafeInteger(Number(rev))))
          throw new RequestError(400, 'Неверная версия изображения знака.')
        const asset = store.getSignPng(code, numbered, rev === null ? undefined : Number(rev))
        if (!asset) throw new RequestError(404, 'Изображение знака не найдено.')
        sendCachedPng(req, res, asset)
      } else if (req.method === 'PUT' && pathname === '/api/crossings') {
        const { expectedRevision, ...draft } = crossingWriteSchema.parse(await readJson(req))
        json(res, 200, store.saveCrossing(draft, expectedRevision))
      } else if (req.method === 'PUT' && pathname === '/api/normative') {
        const { expectedRevision, ...draft } = normativeWriteSchema.parse(await readJson(req))
        json(res, 200, store.saveNormative(draft, expectedRevision))
      } else if (req.method === 'POST' && pathname === '/api/backup') {
        json(res, 201, { filename: await store.createBackup() })
      } else if (req.method === 'GET' && !pathname.startsWith('/api/')) {
        await serveBuiltApp(pathname, res, staticFiles)
      } else {
        throw new RequestError(404, 'Адрес не найден.')
      }
    } catch (error) {
      rejection = parameterRejection(error, parameterId)
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
