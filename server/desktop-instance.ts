import { get, type Server } from 'node:http'
import { databaseIdentity } from './database-identity.ts'
import { createRegistryServer, type StaticFiles } from './index.ts'
import type { DiagnosticsLog } from './diagnostics.ts'
import type { RegistryStore } from './store.ts'

/** Не доверяем одному ready: порт может обслуживать другую базу или другую программу. */
async function servesDatabase(port: number, databaseId: string): Promise<boolean> {
  return new Promise((resolve) => {
    const request = get(`http://127.0.0.1:${port}/api/status`, { timeout: 1_500 }, (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk: string) => {
        body += chunk
        if (body.length > 16_384) request.destroy()
      })
      response.on('error', () => resolve(false))
      response.on('end', () => {
        try {
          const status = JSON.parse(body) as Record<string, unknown>
          resolve(
            response.statusCode === 200 &&
              status.application === 'editor-of-tod' &&
              status.ready === true &&
              status.databaseId === databaseId,
          )
        } catch {
          resolve(false)
        }
      })
    })
    request.on('timeout', () => request.destroy())
    request.on('error', () => resolve(false))
  })
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error)
    server.once('error', onError)
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', onError)
      resolve()
    })
  })
}

/** Возвращает работающую базу или занимает следующий доступный порт, сохраняя выбор базы. */
export async function startDesktopInstance(
  store: RegistryStore,
  initialPort: number,
  staticFiles?: StaticFiles,
  diagnostics?: DiagnosticsLog,
): Promise<{ server: Server | null; port: number }> {
  const databaseId = databaseIdentity(store.path)
  for (let port = initialPort; port <= Math.min(initialPort + 19, 65_535); port++) {
    const server = createRegistryServer(store, port, staticFiles, diagnostics)
    try {
      await listen(server, port)
      return { server, port }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      // Windows может резервировать порт без слушающего процесса (EACCES).
      if (code === 'EACCES') continue
      if (code !== 'EADDRINUSE') throw error
      if (await servesDatabase(port, databaseId)) return { server: null, port }
    }
  }
  throw new Error(
    'Не удалось найти свободный порт. Закройте лишние копии программы или задайте TOD_PORT.',
  )
}
