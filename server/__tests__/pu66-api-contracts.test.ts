import { openTestApplication, type TestApplication } from './test-application'
import type { Server } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHttpServer } from '../http/server'

import { listenHttp } from './http-request-fixture'
import { readCard, readEntry } from './pu66-read-fixture'
import type { Pu66LifecycleWrite } from '../../src/domain/pu66-lifecycle'

const servers: Server[] = [],
  stores: TestApplication[] = []
const headers = { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1:5173' }
afterEach(async () => {
  vi.restoreAllMocks()
  for (const server of servers.splice(0))
    await new Promise<void>((resolve) => server.close(() => resolve()))
  for (const store of stores.splice(0)) store.runtime.close()
})
async function setup() {
  const store = openTestApplication(':memory:', () => '2030-02-01T12:00:00.000Z')
  stores.push(store)
  const server = createHttpServer(store.runtime.http, 0)
  servers.push(server)
  const http = await listenHttp(server)
  return {
    store,
    ...http,
    post: (path: string, body: unknown) =>
      http.send(path, {
        method: 'POST',
        headers: { ...headers, 'Content-Length': String(Buffer.byteLength(JSON.stringify(body))) },
        body: JSON.stringify(body),
      }),
  }
}
const exclusion = (key: string): Pu66LifecycleWrite => ({
  action: 'exclude',
  keys: [key],
  date: '2030-01-30',
  actor: 'Учебный специалист',
  reason: 'closed',
  comment: '',
  successorKey: null,
})

/** These contracts first run against the unchanged index handler. */
describe('PU-66 HTTP compatibility before route extraction', () => {
  it('keeps missing-card statuses, decode-once and the existing broad norms path', async () => {
    const { store, send } = await setup()
    const status = await send('/api/pu66/missing/status')
    expect(status.status).toBe(200)
    expect(JSON.parse(status.body.toString())).toBeNull()
    for (const suffix of ['lifecycle', 'norms', 'scheme', 'verifications']) {
      const response = await send(`/api/pu66/missing/${suffix}`)
      expect(response.status).toBe(404)
      expect(JSON.parse(response.body.toString())).toEqual({ error: 'Карточка ПУ-66 не найдена.' })
    }
    const norms = vi.spyOn(store.pu66, 'getNorms')
    expect((await send('/api/pu66/one/two/norms')).status).toBe(404)
    expect(norms).toHaveBeenLastCalledWith('one/two')
    expect((await send('/api/pu66/%252F/norms')).status).toBe(404)
    expect(norms).toHaveBeenLastCalledWith('%2F')
    norms.mockClear()
    expect((await send('/api/pu66/%ZZ/norms')).status).toBe(400)
    expect(norms).not.toHaveBeenCalled()
    for (const [path, method] of [
      ['/api/pu66/', 'GET'],
      ['/api/pu66/missing/status/extra', 'GET'],
      ['/api/pu66/missing/status', 'POST'],
      ['/api/pu66/lifecycle/preview', 'GET'],
    ] as const) {
      const response = await send(path, { method, headers })
      expect(response.status).toBe(404)
      expect(JSON.parse(response.body.toString())).toEqual({ error: 'Адрес не найден.' })
    }
  })

  it('validates verification body before storage and blocks scheme lookup after exclusion', async () => {
    const { store, send, post } = await setup()
    const record = vi.spyOn(store.pu66Verifications, 'record')
    expect((await post('/api/pu66/missing/verification', {})).status).toBe(400)
    expect(record).not.toHaveBeenCalled()
    const input = {
      expectedRevision: 1,
      verifiedAt: '2030-01-30',
      verifiedBy: 'Учебный специалист',
    }
    expect((await post('/api/pu66/missing/verification', input)).status).toBe(404)
    const entry = readEntry(readCard())
    store.pu66Imports.record([entry])
    const path = `/api/pu66/${encodeURIComponent(entry.card.key)}`
    expect((await post(path + '/verification', input)).status).toBe(201)
    const command = exclusion(entry.card.key)
    store.pu66LifecycleService.record(command, store.pu66LifecycleService.plan(command).fingerprint)
    const fields = vi.spyOn(store.pu66, 'getScheme')
    const response = await send(path + '/scheme')
    expect(response.status).toBe(400)
    expect(JSON.parse(response.body.toString())).toEqual({
      error: 'Карточка ПУ-66 исключена. Выберите действующую карточку.',
    })
    expect(fields).not.toHaveBeenCalled()
    expect((await post(path + '/verification', input)).status).toBe(400)
  })

  it('lists lifecycle with excluded cards/status and rejects a stale plan before backup', async () => {
    const { store, send, post } = await setup()
    const entry = readEntry(readCard())
    store.pu66Imports.record([entry])
    const list = vi.spyOn(store.pu66, 'list'),
      status = vi.spyOn(store.pu66Lifecycle, 'getStatus')
    const response = await send('/api/pu66/lifecycle')
    expect(response.status).toBe(200)
    expect(list).toHaveBeenLastCalledWith(true)
    expect(status).toHaveBeenCalledWith(entry.card.key)
    expect(JSON.parse(response.body.toString())[0]).toMatchObject({
      referenceId: entry.card.key,
      status: { excluded: false },
    })
    const plan = vi.spyOn(store.pu66LifecycleService, 'plan')
    expect((await post('/api/pu66/lifecycle/preview', {})).status).toBe(400)
    expect(plan).not.toHaveBeenCalled()
    const input = exclusion(entry.card.key)
    expect((await post('/api/pu66/lifecycle/preview', input)).status).toBe(200)
    const backup = vi.spyOn(store.runtime.http.pu66.lifecycleCommands, 'createBackup'),
      record = vi.spyOn(store.pu66LifecycleService, 'record')
    expect(
      (await post('/api/pu66/lifecycle/apply', { input, expectedFingerprint: '0'.repeat(64) }))
        .status,
    ).toBe(409)
    expect(backup).not.toHaveBeenCalled()
    expect(record).not.toHaveBeenCalled()
  })
})
