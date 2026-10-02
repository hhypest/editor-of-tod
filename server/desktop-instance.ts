import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { get, type Server } from 'node:http'
import { dirname, join, resolve, basename } from 'node:path'

/** Родительский каталог уже создан. Канонический путь не передаётся в API. */
export function databaseIdentity(path: string): string {
  const absolute = resolve(path)
  let canonical: string
  try {
    canonical = realpathSync(absolute)
  } catch {
    canonical = join(realpathSync(dirname(absolute)), basename(absolute))
  }
  if (process.platform === 'win32') canonical = canonical.toLowerCase()
  return createHash('sha256').update(canonical).digest('hex')
}

function probe(port: number, databaseId: string): Promise<'same' | 'occupied' | 'free'> {
  return new Promise((resolve) => {
    const request = get(`http://127.0.0.1:${port}/api/status`, { timeout: 1500 }, (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk: string) => {
        body += chunk
        if (body.length > 4096) request.destroy()
      })
      response.on('error', () => resolve('occupied'))
      response.on('end', () => {
        try {
          const status = JSON.parse(body) as { ready?: unknown; databaseId?: unknown }
          resolve(
            response.statusCode === 200 && status.ready === true && status.databaseId === databaseId
              ? 'same'
              : 'occupied',
          )
        } catch {
          resolve('occupied')
        }
      })
    })
    request.on('timeout', () => request.destroy())
    request.on('error', (error: NodeJS.ErrnoException) =>
      resolve(error.code === 'ECONNREFUSED' ? 'free' : 'occupied'),
    )
  })
}

/** Пробует статус и реально занимает порт; EADDRINUSE между пробой и listen тоже обрабатывается. */
export async function startDesktopServer(
  preferredPort: number,
  databaseId: string,
  makeServer: (port: number) => Server,
): Promise<
  { port: number; reused: true; server: null } | { port: number; reused: false; server: Server }
> {
  const available: number[] = []
  // Основной порт мог освободиться, пока наша база продолжает работать на следующем.
  // Сначала проверяем весь диапазон, чтобы не открыть один SQLite дважды.
  for (let port = preferredPort; port <= Math.min(65_535, preferredPort + 31); port++) {
    const state = await probe(port, databaseId)
    if (state === 'same') return { port, reused: true, server: null }
    if (state === 'free') available.push(port)
  }
  for (const port of available) {
    const server = makeServer(port)
    try {
      await new Promise<void>((resolve, reject) => {
        const failed = (error: Error) => reject(error)
        server.once('error', failed)
        server.listen(port, '127.0.0.1', () => {
          server.off('error', failed)
          resolve()
        })
      })
      return { port, reused: false, server }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error
      // Другой экземпляр мог запуститься между probe и listen.
      if ((await probe(port, databaseId)) === 'same') return { port, reused: true, server: null }
    }
  }
  throw new Error(
    `Нет свободного порта в диапазоне ${preferredPort}–${Math.min(65_535, preferredPort + 31)}. Укажите другой TOD_PORT.`,
  )
}
