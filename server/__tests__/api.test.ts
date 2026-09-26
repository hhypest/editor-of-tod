import { afterEach, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import { createRegistryServer } from '../index'
import { RegistryStore } from '../store'

const servers: Server[] = []
const stores: RegistryStore[] = []
afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  )
  for (const store of stores.splice(0)) store.close()
})

describe('local API', () => {
  it('accepts a same-origin write and rejects missing origin, invalid input, and stale revisions', async () => {
    const store = new RegistryStore(':memory:')
    stores.push(store)
    const server = createRegistryServer(store, 0)
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Server address missing')
    const url = `http://127.0.0.1:${address.port}`
    const entry = {
      referenceId: 'TEST-003',
      railwayLocation: 'Учебный участок',
      roadName: '',
      roadOwner: '',
      cardReference: '',
      cardUpdatedAt: '',
      verifiedAt: '',
      notes: '',
      expectedRevision: 0,
    }
    const options = {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1:5173' },
      body: JSON.stringify(entry),
    }
    expect(
      (
        await fetch(`${url}/api/crossings`, {
          ...options,
          headers: { 'Content-Type': 'application/json' },
        })
      ).status,
    ).toBe(403)
    expect(
      (
        await fetch(`${url}/api/crossings`, {
          ...options,
          body: JSON.stringify({ ...entry, verifiedAt: 'не дата' }),
        })
      ).status,
    ).toBe(400)
    expect((await fetch(`${url}/api/crossings`, options)).status).toBe(200)
    expect((await fetch(`${url}/api/crossings`, options)).status).toBe(409)
    const rows = await (await fetch(`${url}/api/crossings`)).json()
    expect(rows).toMatchObject([{ referenceId: 'TEST-003', revision: 1 }])
  })
})
