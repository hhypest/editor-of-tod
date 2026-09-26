import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join, extname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ZodError } from 'zod'
import { crossingWriteSchema, normativeWriteSchema } from '../src/domain/registry.ts'
import { RegistryStore, RevisionConflict } from './store.ts'

const port = 4100
const dist = fileURLToPath(new URL('../dist/', import.meta.url))
const databasePath = fileURLToPath(new URL('../private-data/registry.sqlite', import.meta.url))

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

async function readJson(req: IncomingMessage): Promise<unknown> {
  if (!req.headers['content-type']?.startsWith('application/json')) {
    throw new RequestError(415, 'Нужен Content-Type: application/json.')
  }
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.length
    if (size > 64 * 1024) throw new RequestError(413, 'Запись больше 64 КБ.')
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

async function serveBuiltApp(pathname: string, res: ServerResponse): Promise<void> {
  const filename =
    pathname === '/' || pathname === '/index.html'
      ? 'index.html'
      : pathname === '/favicon.svg' || /^\/assets\/[a-zA-Z0-9._-]+$/.test(pathname)
        ? pathname.slice(1)
        : null
  if (!filename) throw new RequestError(404, 'Страница не найдена.')
  try {
    const body = await readFile(join(dist, filename))
    const type = {
      '.html': 'text/html',
      '.js': 'text/javascript',
      '.css': 'text/css',
      '.svg': 'image/svg+xml',
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

export function createRegistryServer(store: RegistryStore, listenPort = port) {
  const server = createServer(async (req, res) => {
    try {
      const address = server.address()
      const actualPort = typeof address === 'object' && address ? address.port : listenPort
      checkRequest(req, actualPort)
      const pathname = new URL(req.url ?? '/', `http://127.0.0.1:${actualPort}`).pathname
      if (req.method === 'GET' && pathname === '/api/status') {
        json(res, 200, { ready: true })
      } else if (req.method === 'GET' && pathname === '/api/crossings') {
        json(res, 200, store.listCrossings())
      } else if (req.method === 'GET' && pathname === '/api/normative') {
        json(res, 200, store.listNormative())
      } else if (req.method === 'PUT' && pathname === '/api/crossings') {
        const { expectedRevision, ...draft } = crossingWriteSchema.parse(await readJson(req))
        json(res, 200, store.saveCrossing(draft, expectedRevision))
      } else if (req.method === 'PUT' && pathname === '/api/normative') {
        const { expectedRevision, ...draft } = normativeWriteSchema.parse(await readJson(req))
        json(res, 200, store.saveNormative(draft, expectedRevision))
      } else if (req.method === 'POST' && pathname === '/api/backup') {
        json(res, 201, { filename: await store.createBackup() })
      } else if (req.method === 'GET' && !pathname.startsWith('/api/')) {
        await serveBuiltApp(pathname, res)
      } else {
        throw new RequestError(404, 'Адрес не найден.')
      }
    } catch (error) {
      if (error instanceof RequestError) json(res, error.status, { error: error.message })
      else if (error instanceof RevisionConflict) json(res, 409, { error: error.message })
      else if (error instanceof ZodError) {
        const issue = error.issues[0]
        json(res, 400, { error: `Неверное поле «${issue?.path.join('.') || 'запись'}».` })
      } else {
        json(res, 500, { error: 'Внутренняя ошибка локального реестра.' })
        console.error('Ошибка локального реестра:', error)
      }
    }
  })
  return server
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.umask(0o077)
  const store = new RegistryStore(databasePath)
  const server = createRegistryServer(store)
  server.listen(port, '127.0.0.1', () => {
    console.log(`Локальный редактор: http://127.0.0.1:${port}/`)
    console.log('Реестр хранится в private-data/registry.sqlite')
  })
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => server.close(() => store.close()))
  }
}
