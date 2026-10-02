import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startDesktopInstance } from '../desktop-instance'
import { RegistryStore } from '../store'

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

/** Свободный порт из ОС не гарантирует доступности соседнего: Windows резервирует диапазоны. */
async function availablePair(): Promise<number> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const first = createServer()
    const next = createServer()
    try {
      await new Promise<void>((resolve, reject) => {
        first.once('error', reject)
        first.listen(0, '127.0.0.1', resolve)
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
  const instance = await startDesktopInstance(store, port ?? (await availablePair()))
  if (instance.server) {
    servers.push(instance.server)
    const address = instance.server.address()
    if (!address || typeof address === 'string') throw new Error('Server address missing')
    return { ...instance, port: address.port }
  }
  return instance
}

describe('desktop instances preserve the selected database', () => {
  it('skips a port reserved by the operating system', async () => {
    const port = await availablePair()
    vi.spyOn(Server.prototype, 'listen').mockImplementationOnce(function (this: Server) {
      queueMicrotask(() =>
        this.emit('error', Object.assign(new Error('Reserved port'), { code: 'EACCES' })),
      )
      return this
    })
    const instance = await start(database(), port)
    expect(instance.server).not.toBeNull()
    expect(instance.port).toBe(port + 1)
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
})
