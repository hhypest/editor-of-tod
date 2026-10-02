import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import type { Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { databaseIdentity, startDesktopServer } from '../desktop-instance'
import { createRegistryServer } from '../index'
import { RegistryStore } from '../store'

const servers: Server[] = []
const stores: RegistryStore[] = []
const directories: string[] = []
afterEach(async () => {
  for (const server of servers.splice(0))
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()))
  for (const store of stores.splice(0)) store.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('desktop database identity', () => {
  it('reuses only the same database and chooses another port for a second program directory', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'tod-instances-'))
    directories.push(directory)
    const paths = ['program-a', 'program-b'].map((program) => {
      const folder = join(directory, program, 'private-data')
      mkdirSync(folder, { recursive: true })
      return join(folder, 'registry.sqlite')
    })
    const identities = paths.map(databaseIdentity)
    const first = new RegistryStore(paths[0]!)
    stores.push(first)
    // Имя базы не меняется после первого создания файла.
    expect(databaseIdentity(paths[0]!)).toBe(identities[0])
    const server = createRegistryServer(first, 0, undefined, undefined, identities[0])
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing address')
    const reused = await startDesktopServer(address.port, identities[0]!, () => {
      throw new Error('The same database must not start another server')
    })
    expect(reused).toEqual({ port: address.port, reused: true, server: null })
    const second = new RegistryStore(paths[1]!)
    stores.push(second)
    const opened = await startDesktopServer(address.port, identities[1]!, (port) => {
      const next = createRegistryServer(second, port, undefined, undefined, identities[1])
      servers.push(next)
      return next
    })
    expect(opened.reused).toBe(false)
    expect(opened.port).toBeGreaterThan(address.port)
    const status = await (await fetch(`http://127.0.0.1:${opened.port}/api/status`)).text()
    expect(JSON.parse(status)).toEqual({ ready: true, databaseId: identities[1] })
    expect(status).not.toContain(directory)
    await new Promise<void>((resolve) => server.close(() => resolve()))
    // Первый порт свободен, но вторую базу повторно открываем на уже выбранном порту.
    const reopened = await startDesktopServer(address.port, identities[1]!, () => {
      throw new Error('Must find the running database before taking the newly free port')
    })
    expect(reopened).toEqual({ port: opened.port, reused: true, server: null })
  })

  it('handles a port occupied between status probing and listen', async () => {
    const store = new RegistryStore(':memory:')
    stores.push(store)
    const existing = createRegistryServer(store, 0)
    await new Promise<void>((resolve) => existing.listen(0, '127.0.0.1', resolve))
    const address = existing.address()
    if (!address || typeof address === 'string') throw new Error('Missing address')
    await new Promise<void>((resolve) => existing.close(() => resolve()))
    let race = true
    const result = await startDesktopServer(address.port, 'race-test', (port) => {
      if (race) {
        race = false
        const other = createRegistryServer(store, port, undefined, undefined, 'other')
        other.listen(port, '127.0.0.1')
        servers.push(other)
      }
      const next = createRegistryServer(store, port, undefined, undefined, 'race-test')
      servers.push(next)
      return next
    })
    expect(result.port).toBeGreaterThan(address.port)
    expect(result.reused).toBe(false)
  })
})
