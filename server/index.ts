import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, join, extname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { z, ZodError } from 'zod'
import {
  MAX_LOCAL_PROJECT_BYTES,
  projectRestoreSchema,
  projectWriteSchema,
} from '../src/domain/local-projects.ts'
import { recoveryDeleteSchema, recoveryWriteSchema } from '../src/domain/recovery.ts'
import { crossingWriteSchema, normativeWriteSchema } from '../src/domain/registry.ts'
import { pu66VerificationWriteSchema } from '../src/domain/pu66-review.ts'
import {
  applyPu66Upload,
  InvalidPu66Upload,
  previewPu66Upload,
  PU66_UPLOAD_REQUEST_BYTES,
} from './pu66-web-import.ts'
import {
  applySignUpload,
  InvalidSignUpload,
  previewSignUpload,
  SIGN_UPLOAD_REQUEST_BYTES,
} from './sign-web-import.ts'
import {
  applyDocumentUpload,
  DOCUMENT_UPLOAD_REQUEST_BYTES,
  InvalidDocumentUpload,
  previewDocumentUpload,
} from './document-web-import.ts'
import { applyPdfSigns, pdfSignImage, previewPdfSigns } from './sign-pdf-import.ts'
import { confirmParameter, InvalidParameter, listParameterStates } from './normative-parameters.ts'
import { documentMetaSchema } from '../src/domain/normative-documents.ts'
import { clientEventsSchema, DiagnosticsLog, routeOf } from './diagnostics.ts'
import { databaseIdentity } from './database-identity.ts'
import {
  InvalidPu66Verification,
  ProjectTooLarge,
  RegistryStore,
  RevisionConflict,
  AmbiguousPu66Key,
  DocumentInUse,
} from './store.ts'

export const DEFAULT_PORT = 4100
const port = DEFAULT_PORT

/** Источник файлов собранного интерфейса: папка `dist/` или ресурсы исполняемого файла. */
export type StaticFiles = (filename: string) => Promise<Buffer>

export function directoryFiles(directory: string): StaticFiles {
  return (filename) => readFile(join(directory, filename))
}

function defaultStaticFiles(): StaticFiles {
  return directoryFiles(fileURLToPath(new URL('../dist/', import.meta.url)))
}

class RequestError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

function json(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  res.end(JSON.stringify(data))
}

async function readJson(req: IncomingMessage, maxBytes = 64 * 1024): Promise<unknown> {
  if (!req.headers['content-type']?.startsWith('application/json')) {
    throw new RequestError(415, 'Нужен Content-Type: application/json.')
  }
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.length
    if (size > maxBytes) throw new RequestError(413, 'Размер JSON-запроса превышен.')
    chunks.push(bytes)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new RequestError(400, 'Некорректный JSON.')
  }
}

function checkRequest(req: IncomingMessage, listenPort: number): void {
  const host = req.headers.host
  if (host !== `127.0.0.1:${listenPort}` && host !== `localhost:${listenPort}`) {
    throw new RequestError(403, 'Допускается только локальное обращение.')
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const allowed = [
      `http://127.0.0.1:${listenPort}`,
      `http://localhost:${listenPort}`,
      'http://127.0.0.1:5173',
      'http://localhost:5173',
      'http://127.0.0.1:4173',
      'http://localhost:4173',
    ]
    if (!req.headers.origin || !allowed.includes(req.headers.origin)) {
      throw new RequestError(403, 'Запись доступна только из локального интерфейса.')
    }
  }
}

function decodeKey(encoded: string): string {
  try {
    return decodeURIComponent(encoded)
  } catch {
    throw new RequestError(400, 'Неверный код в адресе.')
  }
}

function projectId(encoded: string): string {
  const id = decodeKey(encoded)
  if (!z.uuid().safeParse(id).success) throw new RequestError(400, 'Неверный ID проекта.')
  return id
}

/** Сведения о лицензиях сторонних компонентов из сборки интерфейса (раздел «О программе»). */
const LEGAL_FILES = new Set(['/legal/THIRD_PARTY_LICENSES.txt', '/legal/third-party.json'])

async function serveBuiltApp(
  pathname: string,
  res: ServerResponse,
  staticFiles: StaticFiles,
): Promise<void> {
  const filename =
    pathname === '/' || pathname === '/index.html'
      ? 'index.html'
      : pathname === '/favicon.svg' ||
          /^\/assets\/[a-zA-Z0-9._-]+$/.test(pathname) ||
          LEGAL_FILES.has(pathname)
        ? pathname.slice(1)
        : null
  if (!filename) throw new RequestError(404, 'Страница не найдена.')
  try {
    const body = await staticFiles(filename)
    const type = {
      '.html': 'text/html',
      '.js': 'text/javascript',
      '.css': 'text/css',
      '.svg': 'image/svg+xml',
      '.txt': 'text/plain',
      '.json': 'application/json',
    }[extname(filename)]
    if (!type) throw new RequestError(404, 'Файл не найден.')
    res.writeHead(200, {
      'Content-Type': `${type}; charset=utf-8`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
    })
    res.end(body)
  } catch (error) {
    if (error instanceof RequestError) throw error
    throw new RequestError(404, 'Сборка не найдена. Выполните npm run build перед npm run local.')
  }
}

export function createRegistryServer(
  store: RegistryStore,
  listenPort = port,
  staticFiles: StaticFiles = defaultStaticFiles(),
  diagnostics: DiagnosticsLog = new DiagnosticsLog(null, { version: 'dev', mode: 'test' }),
) {
  const databaseId = databaseIdentity(store.path)
  const server = createServer(async (req, res) => {
    const started = performance.now()
    let route = routeOf(req.method ?? 'GET', '/api/?')
    res.on('finish', () => {
      if (route !== 'GET /api/diagnostics')
        diagnostics.request(route, res.statusCode, performance.now() - started)
    })
    try {
      const address = server.address()
      const actualPort = typeof address === 'object' && address ? address.port : listenPort
      const pathname = new URL(req.url ?? '/', `http://127.0.0.1:${actualPort}`).pathname
      route = routeOf(req.method ?? 'GET', pathname)
      checkRequest(req, actualPort)
      const projectPath = /^\/api\/projects\/([^/]+)$/.exec(pathname)
      const revisionListPath = /^\/api\/projects\/([^/]+)\/revisions$/.exec(pathname)
      const revisionPath = /^\/api\/projects\/([^/]+)\/revisions\/(\d+)$/.exec(pathname)
      const restorePath = /^\/api\/projects\/([^/]+)\/restore$/.exec(pathname)
      const recoveryPath = /^\/api\/recovery\/([^/]+)$/.exec(pathname)
      const documentPath =
        /^\/api\/documents\/(\d+)(\/pdf|\/signs\/preview|\/signs\/apply|\/signs\/image)?$/.exec(
          pathname,
        )
      if (req.method === 'GET' && pathname === '/api/status') {
        json(res, 200, { application: 'editor-of-tod', ready: true, databaseId })
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
      } else if (req.method === 'POST' && pathname === '/api/pu66/import/preview') {
        json(
          res,
          200,
          await previewPu66Upload(store, await readJson(req, PU66_UPLOAD_REQUEST_BYTES)),
        )
      } else if (req.method === 'POST' && pathname === '/api/pu66/import/apply') {
        json(res, 200, await applyPu66Upload(store, await readJson(req, PU66_UPLOAD_REQUEST_BYTES)))
      } else if (req.method === 'GET' && pathname === '/api/projects') {
        json(res, 200, store.listProjects())
      } else if (req.method === 'GET' && pathname === '/api/recovery') {
        json(res, 200, store.listRecoveries())
      } else if (req.method === 'GET' && recoveryPath) {
        const record = store.getRecovery(projectId(recoveryPath[1]!))
        if (!record) throw new RequestError(404, 'Копия восстановления не найдена.')
        json(res, 200, record)
      } else if (req.method === 'GET' && revisionPath) {
        const record = store.getProjectRevision(
          projectId(revisionPath[1]!),
          Number(revisionPath[2]),
        )
        if (!record) throw new RequestError(404, 'Редакция проекта не найдена.')
        json(res, 200, record)
      } else if (req.method === 'GET' && revisionListPath) {
        const id = projectId(revisionListPath[1]!)
        if (!store.getProject(id)) throw new RequestError(404, 'Проект не найден.')
        json(res, 200, store.listProjectRevisions(id))
      } else if (req.method === 'GET' && projectPath) {
        const record = store.getProject(projectId(projectPath[1]!))
        if (!record) throw new RequestError(404, 'Проект не найден.')
        json(res, 200, record)
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
        json(res, 200, await confirmParameter(store, id, await readJson(req)))
      } else if (req.method === 'GET' && pathname === '/api/documents') {
        json(res, 200, store.listDocuments())
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
          res.writeHead(200, {
            'Content-Type': 'application/pdf',
            'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
            'X-Content-Type-Options': 'nosniff',
            'Cache-Control': 'no-store',
          })
          res.end(Buffer.from(file.pdf))
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
          res.writeHead(200, {
            'Content-Type': 'image/png',
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
            'Cross-Origin-Resource-Policy': 'same-origin',
            'Content-Security-Policy': "default-src 'none'; sandbox",
          })
          res.end(png)
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
          throw new RequestError(400, 'Укажите редакцию изображения знака.')
        const metadata = store.getSignMetadata(code, Number(rev))
        if (!metadata) throw new RequestError(404, 'Редакция изображения знака не найдена.')
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
          throw new RequestError(400, 'Неверная редакция изображения знака.')
        const asset = store.getSignPng(code, numbered, rev === null ? undefined : Number(rev))
        if (!asset) throw new RequestError(404, 'Изображение знака не найдено.')
        const etag = `"${createHash('sha256').update(asset).digest('hex')}"`
        const unchanged = (req.headers['if-none-match'] ?? '')
          .split(',')
          .some((value) => value.trim().replace(/^W\//, '') === etag || value.trim() === '*')
        res.writeHead(unchanged ? 304 : 200, {
          'Content-Type': 'image/png',
          'Cache-Control': 'private, no-cache',
          ETag: etag,
          'X-Content-Type-Options': 'nosniff',
          'Cross-Origin-Resource-Policy': 'same-origin',
          'Content-Security-Policy': "default-src 'none'; sandbox",
        })
        res.end(unchanged ? undefined : asset)
      } else if (req.method === 'PUT' && pathname === '/api/crossings') {
        const { expectedRevision, ...draft } = crossingWriteSchema.parse(await readJson(req))
        json(res, 200, store.saveCrossing(draft, expectedRevision))
      } else if (req.method === 'PUT' && pathname === '/api/normative') {
        const { expectedRevision, ...draft } = normativeWriteSchema.parse(await readJson(req))
        json(res, 200, store.saveNormative(draft, expectedRevision))
      } else if (req.method === 'PUT' && projectPath) {
        const id = projectId(projectPath[1]!)
        const { expectedRevision, scheme } = projectWriteSchema.parse(
          await readJson(req, MAX_LOCAL_PROJECT_BYTES + 64 * 1024),
        )
        if (scheme.id !== id)
          throw new RequestError(400, 'ID проекта в адресе и файле не совпадают.')
        json(res, 200, store.saveProject(scheme, expectedRevision))
      } else if (req.method === 'PUT' && recoveryPath) {
        const id = projectId(recoveryPath[1]!)
        const input = recoveryWriteSchema.parse(
          await readJson(req, MAX_LOCAL_PROJECT_BYTES + 64 * 1024),
        )
        if (input.sessionId !== id)
          throw new RequestError(400, 'ID копии восстановления в адресе и запросе не совпадают.')
        json(res, 200, store.saveRecovery(input))
      } else if (req.method === 'DELETE' && recoveryPath) {
        const id = projectId(recoveryPath[1]!)
        const { expectedVersion } = recoveryDeleteSchema.parse(await readJson(req))
        store.deleteRecovery(id, expectedVersion)
        json(res, 200, { deleted: true })
      } else if (req.method === 'POST' && restorePath) {
        const id = projectId(restorePath[1]!)
        const { sourceRevision, expectedRevision } = projectRestoreSchema.parse(await readJson(req))
        const restored = store.restoreProject(id, sourceRevision, expectedRevision)
        if (!restored) throw new RequestError(404, 'Редакция проекта не найдена.')
        json(res, 200, restored)
      } else if (req.method === 'POST' && pathname === '/api/backup') {
        json(res, 201, { filename: await store.createBackup() })
      } else if (req.method === 'GET' && !pathname.startsWith('/api/')) {
        await serveBuiltApp(pathname, res, staticFiles)
      } else {
        throw new RequestError(404, 'Адрес не найден.')
      }
    } catch (error) {
      if (error instanceof RequestError) json(res, error.status, { error: error.message })
      else if (error instanceof RevisionConflict || error instanceof AmbiguousPu66Key)
        json(res, 409, { error: error.message })
      else if (error instanceof InvalidPu66Verification) json(res, 400, { error: error.message })
      else if (error instanceof InvalidPu66Upload) json(res, error.status, { error: error.message })
      else if (error instanceof InvalidSignUpload) json(res, error.status, { error: error.message })
      else if (error instanceof InvalidDocumentUpload)
        json(res, error.status, { error: error.message })
      else if (error instanceof DocumentInUse) json(res, 409, { error: error.message })
      else if (error instanceof InvalidParameter) json(res, error.status, { error: error.message })
      else if (error instanceof ProjectTooLarge) json(res, 413, { error: error.message })
      else if (error instanceof ZodError) {
        const issue = error.issues[0]
        json(res, 400, { error: `Неверное поле «${issue?.path.join('.') || 'запись'}».` })
      } else {
        json(res, 500, { error: 'Внутренняя ошибка локального реестра.' })
        diagnostics.serverError(route, error)
        console.error('Ошибка локального реестра:', error)
      }
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
  })
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => server.close(() => store.close()))
  }
}
