import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { randomInt } from 'node:crypto'
import { createServer, Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  findRunningInstance,
  launchDesktop,
  LegacyInstanceRunning,
  startDesktopInstance,
} from '../desktop-instance'
import { RegistryStore, SCHEMA_VERSION } from '../store'

const servers: Server[] = []
const stores: RegistryStore[] = []
const directories: string[] = []
afterEach(async () => {
  for (const server of servers.splice(0))
    await new Promise<void>((resolve) => server.close(() => resolve()))
  for (const store of stores.splice(0)) store.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
  vi.restoreAllMocks()
})

function database() {
  const directory = mkdtempSync(join(tmpdir(), 'tod-instance-'))
  directories.push(directory)
  const store = new RegistryStore(join(directory, 'registry.sqlite'))
  stores.push(store)
  return store
}

/** Windows раздаёт listen(0) и HTTP-клиентам один диапазон временных портов:
 * после проверки пары исходящее соединение может занять соседний порт.
 * Проверяем случайную пару ниже этого диапазона; резервы ОС всё равно пропускаем.
 */
async function availablePair(): Promise<number> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const first = createServer()
    const next = createServer()
    try {
      await new Promise<void>((resolve, reject) => {
        first.once('error', reject)
        first.listen(randomInt(20_000, 40_000), '127.0.0.1', resolve)
      })
      const address = first.address()
      if (!address || typeof address === 'string') throw new Error('Server address missing')
      await new Promise<void>((resolve, reject) => {
        next.once('error', reject)
        next.listen(address.port + 1, '127.0.0.1', resolve)
      })
      return address.port
    } catch (error) {
      if (!['EADDRINUSE', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? ''))
        throw error
    } finally {
      for (const server of [first, next])
        if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
  throw new Error('No available neighbouring ports for the test')
}

async function start(store: RegistryStore, port?: number) {
  const { release, ...instance } = await startDesktopInstance(
    store,
    port ?? (await availablePair()),
  )
  if (instance.server) {
    servers.push(instance.server)
    const address = instance.server.address()
    if (!address || typeof address === 'string') throw new Error('Server address missing')
    return { ...instance, port: address.port, release }
  }
  return { ...instance, release: undefined as (() => void) | undefined }
}

describe('desktop instances preserve the selected database', () => {
  it('skips a port reserved by the operating system', async () => {
    const port = await availablePair()
    const listening = vi.spyOn(Server.prototype, 'listen').mockImplementationOnce(function (
      this: Server,
    ) {
      queueMicrotask(() =>
        this.emit('error', Object.assign(new Error('Reserved port'), { code: 'EACCES' })),
      )
      return this
    })
    const instance = await start(database(), port)
    expect(instance.server).not.toBeNull()
    expect(listening.mock.calls[0]?.[0]).toBe(port)
    expect(instance.port).toBeGreaterThan(port)
  })

  it('reuses the server for the same canonical file without exposing its path', async () => {
    const store = database()
    const first = await start(store)
    const secondStore = new RegistryStore(join(store.path, '..', 'registry.sqlite'))
    stores.push(secondStore)
    expect(await start(secondStore, first.port)).toEqual({ server: null, port: first.port })
    const response = await fetch(`http://127.0.0.1:${first.port}/api/status`)
    const status = (await response.json()) as { databaseId: string }
    expect(status).toMatchObject({ application: 'editor-of-tod', ready: true })
    expect(status.databaseId).toMatch(/^[a-f0-9]{64}$/)
    expect(JSON.stringify(status)).not.toContain(store.path)
  })

  it('starts another database on a free port and finds it on repeated launch', async () => {
    const firstStore = database()
    const first = await start(firstStore)
    const secondStore = database()
    const second = await start(secondStore, first.port)
    expect(second.server).not.toBeNull()
    expect(second.port).toBeGreaterThan(first.port)
    const status = async (port: number) =>
      (await fetch(`http://127.0.0.1:${port}/api/status`)).json() as Promise<{ databaseId: string }>
    expect((await status(first.port)).databaseId).not.toBe((await status(second.port)).databaseId)
    expect(await start(secondStore, first.port)).toEqual({ server: null, port: second.port })
  })

  it('does not reuse an unrelated server that happens to report ready', async () => {
    const foreign = createServer((_req, res) => res.end('{"ready":true}'))
    servers.push(foreign)
    const port = await availablePair()
    await new Promise<void>((resolve) => foreign.listen(port, '127.0.0.1', resolve))
    const address = foreign.address()
    if (!address || typeof address === 'string') throw new Error('Server address missing')
    const instance = await start(database(), address.port)
    expect(instance.server).not.toBeNull()
    expect(instance.port).toBeGreaterThan(address.port)
  })

  describe('looking for a running program before the database file is opened', () => {
    const marker = (store: RegistryStore) => `${store.path}.instance.json`
    /** Порт вне диапазона работающей программы: поиск по портам её не найдёт. */
    const elsewhere = (port: number) => (port > 30_000 ? port - 5_000 : port + 5_000)

    it('finds the program by the marker next to the database, whatever port range is scanned', async () => {
      const store = database()
      const first = await start(store)
      expect(JSON.parse(readFileSync(marker(store), 'utf8'))).toMatchObject({ port: first.port })
      expect(await findRunningInstance(store.path, elsewhere(first.port))).toBe(first.port)
      // Без отметки остаётся прежний поиск по отпечатку пути в диапазоне портов.
      rmSync(marker(store))
      expect(await findRunningInstance(store.path, elsewhere(first.port))).toBeNull()
      expect(await findRunningInstance(store.path, first.port - 3)).toBe(first.port)
    })

    it('removes its marker on exit and ignores a marker left by a crashed program', async () => {
      const store = database()
      const first = await start(store)
      const stale = readFileSync(marker(store), 'utf8')
      first.release!()
      expect(existsSync(marker(store))).toBe(false)
      await new Promise<void>((resolve) => first.server!.close(() => resolve()))
      servers.splice(servers.indexOf(first.server!), 1)
      // Аварийное завершение: отметка осталась, а порт заняла программа с другой базой.
      const other = await start(database(), first.port)
      writeFileSync(marker(store), stale.replace(/"port":\d+/, `"port":${other.port}`))
      expect(await findRunningInstance(store.path, elsewhere(other.port))).toBeNull()
    })

    it('does not take a copied folder for the running original', async () => {
      const store = database()
      const first = await start(store)
      const copyDirectory = mkdtempSync(join(tmpdir(), 'tod-instance-copy-'))
      directories.push(copyDirectory)
      const copy = join(copyDirectory, 'registry.sqlite')
      copyFileSync(store.path, copy)
      copyFileSync(marker(store), `${copy}.instance.json`)
      expect(await findRunningInstance(copy, elsewhere(first.port))).toBeNull()
    })

    it('opens neither a new nor an outdated database when the program is already running', async () => {
      const missing = join(mkdtempSync(join(tmpdir(), 'tod-instance-new-')), 'registry.sqlite')
      directories.push(join(missing, '..'))
      expect(await findRunningInstance(missing, await availablePair())).toBeNull()
      expect(existsSync(missing)).toBe(false)

      const store = database()
      const first = await start(store)
      const again = await launchDesktop(store.path, first.port)
      expect(again).toEqual({ running: true, port: first.port })
    })

    it('refuses to start next to a build that cannot tell which database it serves', async () => {
      const directory = mkdtempSync(join(tmpdir(), 'tod-instance-legacy-'))
      directories.push(directory)
      const path = join(directory, 'registry.sqlite')
      new RegistryStore(path).close()
      const raw = new DatabaseSync(path)
      raw.exec(
        'ALTER TABLE project_recovery DROP COLUMN owner_until; ALTER TABLE project_recovery DROP COLUMN owner_id; PRAGMA user_version = 12;',
      )
      raw.close()
      const legacy = createServer((_req, res) => {
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.end('{"ready":true}')
      })
      servers.push(legacy)
      const port = await availablePair()
      await new Promise<void>((resolve) => legacy.listen(port + 1, '127.0.0.1', resolve))

      await expect(launchDesktop(path, port)).rejects.toBeInstanceOf(LegacyInstanceRunning)
      await expect(launchDesktop(path, port)).rejects.toThrow(`На порту ${port + 1}`)
      // База не открывалась: схема прежняя, копий и отметки нет.
      const untouched = new DatabaseSync(path, { readOnly: true })
      expect(untouched.prepare('PRAGMA user_version').get()).toEqual({ user_version: 12 })
      untouched.close()
      expect(existsSync(join(directory, 'backups'))).toBe(false)
      expect(existsSync(`${path}.instance.json`)).toBe(false)

      await new Promise<void>((resolve) => legacy.close(() => resolve()))
      servers.splice(servers.indexOf(legacy), 1)
      const launched = await launchDesktop(path, port)
      if (launched.running) throw new Error('Expected a started instance')
      servers.push(launched.server)
      stores.push(launched.store)
      expect(launched.store.migratedFrom).toBe(12)
      expect(launched.store.schemaVersion()).toBe(SCHEMA_VERSION)
    })
  })
})
