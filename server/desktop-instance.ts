import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { get, type Server } from 'node:http'
import { databaseIdentity } from './database-identity.ts'
import { createRegistryServer, type StaticFiles } from './index.ts'
import type { DiagnosticsLog } from './diagnostics.ts'
import { RegistryStore } from './store.ts'

type Status = { body: Record<string, unknown>; json: boolean }

/** Ответ `/api/status` на порту или `null`, если там никто не отвечает разборчивым JSON. */
async function readStatus(port: number): Promise<Status | null> {
  return new Promise((resolve) => {
    const request = get(`http://127.0.0.1:${port}/api/status`, { timeout: 1_500 }, (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk: string) => {
        body += chunk
        if (body.length > 16_384) request.destroy()
      })
      response.on('error', () => resolve(null))
      response.on('end', () => {
        try {
          const parsed: unknown = JSON.parse(body)
          resolve(
            response.statusCode === 200 && parsed !== null && typeof parsed === 'object'
              ? {
                  body: parsed as Record<string, unknown>,
                  json: /^application\/json\b/i.test(response.headers['content-type'] ?? ''),
                }
              : null,
          )
        } catch {
          resolve(null)
        }
      })
    })
    request.on('timeout', () => request.destroy())
    request.on('error', () => resolve(null))
  })
}

function isEditor(status: Status | null): status is Status {
  return status?.body.application === 'editor-of-tod' && status.body.ready === true
}

/** Не доверяем одному ready: порт может обслуживать другую базу или другую программу. */
async function servesDatabase(port: number, databaseId: string): Promise<boolean> {
  const status = await readStatus(port)
  return isEditor(status) && status.body.databaseId === databaseId
}

/**
 * Сборки до 02.10.2026 отвечали на `/api/status` только `{"ready":true}` и не сообщали,
 * какую базу обслуживают.
 */
function isLegacyBuild(status: Status | null): boolean {
  return (
    status !== null &&
    status.json &&
    status.body.ready === true &&
    Object.keys(status.body).length === 1
  )
}

/** Сколько портов подряд, начиная с заданного, программа пробует занять и опрашивает. */
const PORT_ATTEMPTS = 20

function candidatePorts(initialPort: number): number[] {
  const ports: number[] = []
  for (let port = initialPort; port <= Math.min(initialPort + PORT_ATTEMPTS - 1, 65_535); port++)
    ports.push(port)
  return ports
}

/**
 * Отметка работающей программы рядом с файлом базы. В отличие от отпечатка пути, она одна и
 * та же, каким бы путём ни открыли папку (буква диска, сетевое имя, ссылка).
 */
type InstanceMarker = { instanceId: string; port: number; fileId: string | null }

function markerPath(databasePath: string): string {
  return `${databasePath}.instance.json`
}

/** Номер файла в файловой системе: у копии папки он другой, поэтому чужая отметка не подойдёт. */
function fileIdentity(path: string): string | null {
  try {
    const { ino } = statSync(path, { bigint: true })
    return ino > 0n ? String(ino) : null
  } catch {
    return null
  }
}

function readMarker(databasePath: string): InstanceMarker | null {
  try {
    const value: unknown = JSON.parse(readFileSync(markerPath(databasePath), 'utf8'))
    if (value === null || typeof value !== 'object') return null
    const { instanceId, port, fileId } = value as Record<string, unknown>
    if (typeof instanceId !== 'string' || !Number.isInteger(port)) return null
    if ((port as number) < 1 || (port as number) > 65_535) return null
    return { instanceId, port: port as number, fileId: typeof fileId === 'string' ? fileId : null }
  } catch {
    return null
  }
}

function writeMarker(databasePath: string, marker: InstanceMarker): void {
  try {
    writeFileSync(markerPath(databasePath), `${JSON.stringify(marker)}\n`, { mode: 0o600 })
  } catch {
    // Папка только для чтения: остаётся поиск по отпечатку пути.
  }
}

function removeMarker(databasePath: string, instanceId: string): void {
  try {
    if (readMarker(databasePath)?.instanceId === instanceId) rmSync(markerPath(databasePath))
  } catch {
    // Отметку уже убрали или папка недоступна.
  }
}

export class LegacyInstanceRunning extends Error {
  readonly port: number
  constructor(port: number) {
    super(
      `На порту ${port} работает прежняя сборка редактора, которая не сообщает, какую базу она открыла. Закройте её окно и запустите программу снова: две программы на одной базе могут повредить данные.`,
    )
    this.port = port
  }
}

/**
 * Ищет программу, уже открывшую эту базу, не открывая и не обновляя сам файл базы.
 * Возвращает её порт или `null`. Прежняя сборка в диапазоне портов — ошибка: проверить, с какой
 * базой она работает, нельзя.
 */
export async function findRunningInstance(
  databasePath: string,
  initialPort: number,
): Promise<number | null> {
  if (databasePath === ':memory:' || !existsSync(databasePath)) return null
  const marker = readMarker(databasePath)
  const fileId = fileIdentity(databasePath)
  if (marker && (marker.fileId === null || fileId === null || marker.fileId === fileId)) {
    const status = await readStatus(marker.port)
    if (isEditor(status) && status.body.instanceId === marker.instanceId) return marker.port
  }
  const databaseId = databaseIdentity(databasePath)
  const ports = candidatePorts(initialPort)
  const statuses = await Promise.all(ports.map((port) => readStatus(port)))
  const same = statuses.findIndex(
    (status) => isEditor(status) && status.body.databaseId === databaseId,
  )
  if (same >= 0) return ports[same]!
  const legacy = statuses.findIndex(isLegacyBuild)
  if (legacy >= 0) throw new LegacyInstanceRunning(ports[legacy]!)
  return null
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
): Promise<{ server: Server | null; port: number; release: () => void }> {
  const databaseId = databaseIdentity(store.path)
  const instanceId = randomUUID()
  for (const port of candidatePorts(initialPort)) {
    const server = createRegistryServer(store, port, staticFiles, diagnostics, instanceId)
    try {
      await listen(server, port)
      const address = server.address()
      const actualPort = typeof address === 'object' && address ? address.port : port
      if (store.path !== ':memory:')
        writeMarker(store.path, {
          instanceId,
          port: actualPort,
          fileId: fileIdentity(store.path),
        })
      return { server, port, release: () => removeMarker(store.path, instanceId) }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      // Windows может резервировать порт без слушающего процесса (EACCES).
      if (code === 'EACCES') continue
      if (code !== 'EADDRINUSE') throw error
      if (await servesDatabase(port, databaseId))
        return { server: null, port, release: () => undefined }
    }
  }
  throw new Error(
    'Не удалось найти свободный порт. Закройте лишние копии программы или задайте TOD_PORT.',
  )
}

/**
 * Запуск программы для одной базы. Порядок важен: сначала ищем уже работающую программу,
 * и только если её нет — открываем файл базы (это может обновить его схему).
 */
export async function launchDesktop(
  databasePath: string,
  initialPort: number,
  options: { staticFiles?: StaticFiles; diagnostics?: () => DiagnosticsLog } = {},
): Promise<
  | { running: true; port: number }
  | { running: false; port: number; server: Server; store: RegistryStore; release: () => void }
> {
  const running = await findRunningInstance(databasePath, initialPort)
  if (running !== null) return { running: true, port: running }
  const store = new RegistryStore(databasePath)
  try {
    const instance = await startDesktopInstance(
      store,
      initialPort,
      options.staticFiles,
      options.diagnostics?.(),
    )
    if (!instance.server) {
      // Другая программа успела занять порт для этой базы между проверкой и запуском.
      store.close()
      return { running: true, port: instance.port }
    }
    return { running: false, store, ...instance, server: instance.server }
  } catch (error) {
    store.close()
    throw error
  }
}
