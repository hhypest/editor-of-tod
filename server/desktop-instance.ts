import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { get, type Server } from 'node:http'
import { hostname } from 'node:os'
import { dirname } from 'node:path'
import { databaseIdentity } from './database-identity.ts'
import { createRegistryServer, DEFAULT_PORT, type StaticFiles } from './index.ts'
import type { DiagnosticsLog } from './diagnostics.ts'
import { RegistryStore } from './store.ts'

type JsonReply = { body: unknown; json: boolean }

/** Ответ 200 с разборчивым JSON по локальному адресу или `null`. */
async function getJson(port: number, path: string): Promise<JsonReply | null> {
  return new Promise((resolve) => {
    const request = get(`http://127.0.0.1:${port}${path}`, { timeout: 1_500 }, (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk: string) => {
        body += chunk
        if (body.length > 262_144) request.destroy()
      })
      response.on('error', () => resolve(null))
      response.on('end', () => {
        try {
          resolve(
            response.statusCode === 200
              ? {
                  body: JSON.parse(body) as unknown,
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

type Status = { body: Record<string, unknown>; json: boolean }

/** Ответ `/api/status` на порту или `null`, если там никто не отвечает разборчивым JSON. */
async function readStatus(port: number, query = ''): Promise<Status | null> {
  const reply = await getJson(port, `/api/status${query}`)
  return reply &&
    reply.body !== null &&
    typeof reply.body === 'object' &&
    !Array.isArray(reply.body)
    ? { body: reply.body as Record<string, unknown>, json: reply.json }
    : null
}

function isEditor(status: Status | null): status is Status {
  return status?.body.application === 'editor-of-tod' && status.body.ready === true
}

/**
 * Обслуживает ли программа на порту именно этот файл базы. Рядом с базой создаётся пустой
 * файл со случайным именем, и программу спрашивают, видит ли она его рядом со своей базой.
 * Ответ не зависит от того, каким путём открыта папка (буква диска, сетевое имя, ссылка), и
 * отличает копию папки от оригинала. Сборка без такой проверки или папка только для чтения —
 * сравнение по отпечатку пути.
 */
async function servesFile(port: number, databasePath: string): Promise<boolean> {
  const probeId = randomUUID()
  const probePath = `${databasePath}.probe-${probeId}`
  let written = false
  try {
    writeFileSync(probePath, '', { flag: 'wx', mode: 0o600 })
    written = true
  } catch {
    // Папка недоступна для записи: остаётся отпечаток пути.
  }
  try {
    const status = await readStatus(port, written ? `?probe=${probeId}` : '')
    if (!isEditor(status)) return false
    if (written && typeof status.body.probe === 'boolean') return status.body.probe
    return status.body.databaseId === databaseIdentity(databasePath)
  } finally {
    if (written) rmSync(probePath, { force: true })
  }
}

/**
 * Сборки до 02.10.2026 отвечали на `/api/status` только `{"ready":true}` и не сообщали,
 * какую базу обслуживают. Такой же ответ может дать посторонняя служба, поэтому дополнительно
 * запрашивается реестр нормативных записей редактора.
 */
async function isLegacyBuild(port: number, status: Status | null): Promise<boolean> {
  if (!status?.json || status.body.ready !== true || Object.keys(status.body).length !== 1)
    return false
  const normative = await getJson(port, '/api/normative')
  return (
    normative !== null &&
    normative.json &&
    Array.isArray(normative.body) &&
    normative.body.length > 0 &&
    normative.body.every(
      (entry: unknown) =>
        entry !== null &&
        typeof entry === 'object' &&
        typeof (entry as Record<string, unknown>).documentCode === 'string' &&
        typeof (entry as Record<string, unknown>).reviewStatus === 'string',
    )
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
 * Отметка работающей программы рядом с файлом базы: по ней порт находится, даже если он вне
 * опрашиваемого диапазона. Сама отметка ничего не доказывает (её могли скопировать вместе с
 * папкой) — программу на этом порту проверяет `servesFile`.
 */
type InstanceMarker = { instanceId: string; port: number }

function markerPath(databasePath: string): string {
  return `${databasePath}.instance.json`
}

function readMarker(databasePath: string): InstanceMarker | null {
  try {
    const value: unknown = JSON.parse(readFileSync(markerPath(databasePath), 'utf8'))
    if (value === null || typeof value !== 'object') return null
    const { instanceId, port } = value as Record<string, unknown>
    if (typeof instanceId !== 'string' || !Number.isInteger(port)) return null
    if ((port as number) < 1 || (port as number) > 65_535) return null
    return { instanceId, port: port as number }
  } catch {
    return null
  }
}

function writeMarker(databasePath: string, marker: InstanceMarker): void {
  try {
    writeFileSync(markerPath(databasePath), `${JSON.stringify(marker)}\n`, { mode: 0o600 })
  } catch {
    // Папка только для чтения: остаётся поиск по диапазону портов.
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

/** Программа по отметке рядом с базой — без опроса диапазона портов. */
async function findByMarker(databasePath: string): Promise<number | null> {
  if (databasePath === ':memory:' || !existsSync(databasePath)) return null
  const marker = readMarker(databasePath)
  return marker && (await servesFile(marker.port, databasePath)) ? marker.port : null
}

/**
 * Ищет программу, уже открывшую эту базу, не открывая и не обновляя сам файл базы.
 * Возвращает её порт или `null`. Опрашиваются порт из отметки, диапазон от заданного порта и
 * диапазон от порта по умолчанию. Прежняя сборка в этих диапазонах — ошибка: проверить, с
 * какой базой она работает, нельзя. Прежнюю сборку на произвольном другом порту (свой
 * `TOD_PORT`) обнаружить нечем: она не оставляет ни отметки, ни блокировки файла.
 */
export async function findRunningInstance(
  databasePath: string,
  initialPort: number,
  defaultPort: number = DEFAULT_PORT,
): Promise<number | null> {
  if (databasePath === ':memory:' || !existsSync(databasePath)) return null
  const marked = await findByMarker(databasePath)
  if (marked !== null) return marked
  const ports = [...new Set([...candidatePorts(initialPort), ...candidatePorts(defaultPort)])]
  const statuses = await Promise.all(ports.map((port) => readStatus(port)))
  for (const [index, status] of statuses.entries())
    if (isEditor(status) && (await servesFile(ports[index]!, databasePath))) return ports[index]!
  for (const [index, status] of statuses.entries())
    if (await isLegacyBuild(ports[index]!, status)) throw new LegacyInstanceRunning(ports[index]!)
  return null
}

const LOCK_STALE_MS = 120_000
const LOCK_WAIT_MS = 150_000

function lockPath(databasePath: string): string {
  return `${databasePath}.launch.lock`
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Замок оставлен завершившимся запуском: процесса на этом компьютере нет или файл давно не менялся. */
function lockIsStale(path: string): boolean {
  try {
    const ageMs = Date.now() - statSync(path).mtimeMs
    if (ageMs > LOCK_STALE_MS) return true
    const holder = JSON.parse(readFileSync(path, 'utf8')) as { pid?: unknown; host?: unknown }
    return (
      holder.host === hostname() &&
      Number.isInteger(holder.pid) &&
      !processAlive(holder.pid as number)
    )
  } catch {
    // Замок исчез или ещё не дописан: решит следующая попытка.
    return false
  }
}

/**
 * Один запуск на базу за раз: между поиском работающей программы и открытием файла базы
 * второй запуск (двойной щелчок дважды) иначе начал бы то же обновление схемы. Пока замок
 * занят, ждём и проверяем, не появилась ли программа. Возвращает снятие замка или порт
 * программы, запущенной другим процессом.
 */
async function acquireLaunchLock(
  databasePath: string,
): Promise<{ release: () => void } | { running: number }> {
  const path = lockPath(databasePath)
  const unlocked = { release: () => undefined }
  if (databasePath === ':memory:') return unlocked
  try {
    mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 })
  } catch {
    return unlocked
  }
  const started = Date.now()
  for (;;) {
    try {
      writeFileSync(
        path,
        JSON.stringify({ pid: process.pid, host: hostname(), startedAt: new Date().toISOString() }),
        { flag: 'wx', mode: 0o600 },
      )
      return { release: () => rmSync(path, { force: true }) }
    } catch (error) {
      // Замок создать нельзя (папка только для чтения): запуск продолжается без него.
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return unlocked
    }
    if (lockIsStale(path)) {
      rmSync(path, { force: true })
      continue
    }
    const running = await findByMarker(databasePath)
    if (running !== null) return { running }
    if (Date.now() - started > LOCK_WAIT_MS)
      throw new Error(
        'Другой запуск программы всё ещё открывает эту базу. Дождитесь его окна или закройте его и повторите запуск.',
      )
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
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
  const instanceId = randomUUID()
  for (const port of candidatePorts(initialPort)) {
    const server = createRegistryServer(store, port, staticFiles, diagnostics, instanceId)
    try {
      await listen(server, port)
      const address = server.address()
      const actualPort = typeof address === 'object' && address ? address.port : port
      if (store.path !== ':memory:') writeMarker(store.path, { instanceId, port: actualPort })
      return { server, port, release: () => removeMarker(store.path, instanceId) }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      // Windows может резервировать порт без слушающего процесса (EACCES).
      if (code === 'EACCES') continue
      if (code !== 'EADDRINUSE') throw error
      // Не доверяем одному ready: порт может обслуживать другую базу или другую программу.
      if (await servesFile(port, store.path))
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
  const lock = await acquireLaunchLock(databasePath)
  if ('running' in lock) return { running: true, port: lock.running }
  try {
    // Пока мы искали программу и ждали замок, другой запуск мог завершиться и оставить отметку.
    const started = await findByMarker(databasePath)
    if (started !== null) return { running: true, port: started }
    const store = new RegistryStore(databasePath)
    try {
      const instance = await startDesktopInstance(
        store,
        initialPort,
        options.staticFiles,
        options.diagnostics?.(),
      )
      if (!instance.server) {
        // Порт для этой базы занят программой, которая не оставила отметку.
        store.close()
        return { running: true, port: instance.port }
      }
      return { running: false, store, ...instance, server: instance.server }
    } catch (error) {
      store.close()
      throw error
    }
  } finally {
    lock.release()
  }
}
