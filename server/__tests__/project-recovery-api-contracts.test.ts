import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { Server } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { importSchemeJson } from '../../src/domain/import'
import { createRegistryServer } from '../index'
import { RegistryStore } from '../store'
import { listenHttp } from './http-request-fixture'

const scheme = importSchemeJson(readFileSync('tests/fixtures/manual-v1.json', 'utf8')).scheme
const servers: Server[] = [],
  stores: RegistryStore[] = []
const headers = { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1:5173' }
afterEach(async () => {
  vi.restoreAllMocks()
  for (const server of servers.splice(0))
    await new Promise<void>((resolve) => server.close(() => resolve()))
  for (const store of stores.splice(0)) store.close()
})
async function setup() {
  const store = new RegistryStore(':memory:')
  stores.push(store)
  const server = createRegistryServer(store, 0)
  servers.push(server)
  const http = await listenHttp(server)
  return {
    store,
    ...http,
    write: (path: string, body: unknown, method = 'PUT') =>
      http.send(path, {
        method,
        headers: { ...headers, 'Content-Length': String(Buffer.byteLength(JSON.stringify(body))) },
        body: JSON.stringify(body),
      }),
  }
}

/** These contracts first run before moving the project/recovery routes. */
describe('project/recovery route compatibility', () => {
  it('validates URL then body then project identity before storage and keeps history lookup order', async () => {
    const { store, send, write } = await setup()
    const save = vi.spyOn(store, 'saveProject')
    expect((await write('/api/projects/%ZZ', null)).status).toBe(400)
    expect((await write(`/api/projects/${scheme.id}`, null)).status).toBe(400)
    const mismatch = await write(`/api/projects/${randomUUID()}`, { scheme, expectedRevision: 0 })
    expect(JSON.parse(mismatch.body.toString())).toEqual({
      error: 'ID проекта в адресе и файле не совпадают.',
    })
    expect(save).not.toHaveBeenCalled()
    const get = vi.spyOn(store, 'getProject'),
      revisions = vi.spyOn(store, 'listProjectRevisions')
    const missing = await send(`/api/projects/${scheme.id}/revisions`)
    expect(missing.status).toBe(404)
    expect(revisions).not.toHaveBeenCalled()
    store.saveProject(scheme, 0)
    get.mockClear()
    expect((await send(`/api/projects/${scheme.id}/revisions`)).status).toBe(200)
    expect(get.mock.invocationCallOrder[0]).toBeLessThan(revisions.mock.invocationCallOrder[0]!)
    for (const suffix of ['/revisions/0', '/revisions/999']) {
      const response = await send(`/api/projects/${scheme.id}${suffix}`)
      expect(response.status).toBe(404)
      expect(JSON.parse(response.body.toString())).toEqual({
        error: 'Версия проекта не найдена. Обновите список проектов и повторите действие.',
      })
    }
  })

  it('passes an explicit recovery access guard and validates query/body before storage', async () => {
    const { store, send, write } = await setup()
    const sessionId = randomUUID(),
      ownerId = randomUUID()
    const path = `/api/recovery/${sessionId}`
    const input = {
      sessionId,
      ownerId,
      scheme,
      expectedVersion: 0,
      baseRevision: null,
      detailsDraft: null,
      placementDraft: null,
      fileName: 'fictional.json',
    }
    const get = vi.spyOn(store, 'getRecovery'),
      save = vi.spyOn(store, 'saveRecovery')
    expect((await send(path + '?ownerId=invalid')).status).toBe(400)
    expect(get).not.toHaveBeenCalled()
    expect((await send(path)).status).toBe(404)
    expect(get).toHaveBeenLastCalledWith(sessionId, { ownerId: undefined })
    const mismatch = await write(path, { ...input, sessionId: randomUUID() })
    expect(mismatch.status).toBe(400)
    expect(JSON.parse(mismatch.body.toString())).toEqual({
      error: 'ID копии восстановления в адресе и запросе не совпадают.',
    })
    expect(save).not.toHaveBeenCalled()
    expect((await write(path, input)).status).toBe(200)
    get.mockClear()
    expect((await send(path)).status).toBe(409)
    expect((await send(path + `?ownerId=${ownerId}`)).status).toBe(200)
    expect(get).toHaveBeenLastCalledWith(sessionId, { ownerId })
    expect((await write(path, { expectedVersion: 1 }, 'DELETE')).status).toBe(400)
    expect(store.getRecovery(sessionId)?.version).toBe(1)
  })

  it('keeps unsupported methods and partial paths as global 404 without storage effects', async () => {
    const { store, send } = await setup()
    const list = vi.spyOn(store, 'listProjects'),
      recoveries = vi.spyOn(store, 'listRecoveries')
    for (const [path, method] of [
      ['/api/projects', 'POST'],
      ['/api/recovery', 'PUT'],
      [`/api/projects/${scheme.id}/restore`, 'GET'],
      [`/api/projects/${scheme.id}/revisions/-1`, 'GET'],
      [`/api/recovery/${randomUUID()}/claim`, 'GET'],
      [`/api/recovery/${randomUUID()}/other`, 'POST'],
      ['/api/projects/', 'GET'],
      ['/api/recovery/', 'GET'],
    ] as const) {
      const response = await send(path, { method, headers })
      expect(response.status).toBe(404)
      expect(JSON.parse(response.body.toString())).toEqual({ error: 'Адрес не найден.' })
    }
    expect(list).not.toHaveBeenCalled()
    expect(recoveries).not.toHaveBeenCalled()
  })
})
