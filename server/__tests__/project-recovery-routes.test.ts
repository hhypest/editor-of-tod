import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { importSchemeJson } from '../../src/domain/import'
import { RECOVERY_LEASE_MS } from '../../src/application/recovery-session'
import { recoveryReceiptSchema } from '../../src/application/recovery-contract'
import { createServerServices } from '../composition-root'
import { createProjectRoutes, type ProjectRouteStorage } from '../http/routes/projects'
import { createRecoveryRoutes, type RecoveryRouteStorage } from '../http/routes/recovery'
import type { RouteHandler } from '../http/route'
import { checkRequest } from '../http/security'
import { writeHttpError } from '../http/error-mapper'
import { json } from '../http/json'
import { listenHttp } from './http-request-fixture'

const scheme = importSchemeJson(readFileSync('tests/fixtures/manual-v1.json', 'utf8')).scheme
const servers: Server[] = [],
  connections: DatabaseSync[] = []
const headers = { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1:5173' }
afterEach(async () => {
  vi.restoreAllMocks()
  for (const server of servers.splice(0))
    await new Promise<void>((resolve) => server.close(() => resolve()))
  for (const db of connections.splice(0)) db.close()
})
async function serve(routes: RouteHandler[]) {
  const diagnostics = { serverError: vi.fn() },
    fallbacks: Array<{ read: boolean; sent: boolean }> = []
  const server = createServer(async (req, res) => {
    try {
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Missing address')
      checkRequest(req, address.port)
      const url = new URL(req.url!, `http://127.0.0.1:${address.port}`)
      for (const route of routes) if (await route(req, res, url)) return
      fallbacks.push({ read: req.readableDidRead, sent: res.headersSent })
      json(res, 404, { fallback: true })
    } catch (error) {
      writeHttpError(res, error, 'test route', diagnostics)
    }
  })
  servers.push(server)
  const http = await listenHttp(server)
  return {
    ...http,
    diagnostics,
    fallbacks,
    write: (path: string, value: unknown, method = 'PUT') =>
      http.send(path, {
        method,
        headers: { ...headers, 'Content-Length': String(Buffer.byteLength(JSON.stringify(value))) },
        body: JSON.stringify(value),
      }),
  }
}
async function setup() {
  let now = Date.parse('2030-01-01T00:00:00.000Z')
  const services = createServerServices(':memory:', () => new Date(now).toISOString())
  connections.push(services.db)
  return {
    ...services,
    ...(await serve([
      createProjectRoutes(services.projects),
      createRecoveryRoutes(services.recovery),
    ])),
    advance: (milliseconds: number) => {
      now += milliseconds
    },
  }
}
const input = () => ({
  sessionId: randomUUID(),
  ownerId: randomUUID(),
  scheme,
  expectedVersion: 0,
  baseRevision: null,
  detailsDraft: null,
  placementDraft: null,
  fileName: 'fictional.json',
})
const record = { scheme, revision: 1, updatedAt: '2030-01-01T00:00:00.000Z' }
function projectPorts(): ProjectRouteStorage {
  return {
    list: vi.fn(() => []),
    get: vi.fn(() => null),
    listRevisions: vi.fn(() => []),
    getRevision: vi.fn(() => null),
    save: vi.fn(() => record),
    restore: vi.fn(() => null),
  }
}
function recoveryPorts(): RecoveryRouteStorage {
  return {
    list: vi.fn(() => []),
    get: vi.fn(() => null),
    claim: vi.fn(() => {
      throw new Error('Unused')
    }),
    renew: vi.fn(),
    release: vi.fn(),
    save: vi.fn(() => {
      throw new Error('Unused')
    }),
    delete: vi.fn(),
  }
}

describe('project/recovery HTTP groups without RegistryStore', () => {
  it('saves/no-ops/conflicts and restores a new project revision while preserving old snapshots', async () => {
    const { send, write } = await setup(),
      path = `/api/projects/${scheme.id}`
    expect((await write(path, { scheme, expectedRevision: 0 })).status).toBe(200)
    expect(
      JSON.parse((await write(path, { scheme, expectedRevision: 1 })).body.toString()).revision,
    ).toBe(1)
    const changed = structuredClone(scheme)
    changed.parameters.locationText = 'Учебная правка'
    expect(
      JSON.parse((await write(path, { scheme: changed, expectedRevision: 1 })).body.toString())
        .revision,
    ).toBe(2)
    expect((await write(path, { scheme, expectedRevision: 1 })).status).toBe(409)
    expect(JSON.parse((await send('/api/projects')).body.toString())).toMatchObject([
      { id: scheme.id, revision: 2 },
    ])
    expect(
      JSON.parse((await send(path + '/revisions')).body.toString()).map(
        (r: { revision: number }) => r.revision,
      ),
    ).toEqual([2, 1])
    expect(
      (await write(path + '/restore', { sourceRevision: 999, expectedRevision: 2 }, 'POST')).status,
    ).toBe(404)
    const restored = await write(
      path + '/restore',
      { sourceRevision: 1, expectedRevision: 2 },
      'POST',
    )
    expect(JSON.parse(restored.body.toString())).toMatchObject({ scheme, revision: 3 })
    expect(JSON.parse((await send(path + '/revisions/1')).body.toString()).scheme).toEqual(scheme)
    expect(JSON.parse((await send(path)).body.toString()).revision).toBe(3)
  })

  it('keeps the atomic ownership guard, source receipt, claim/heartbeat/release and delete versions', async () => {
    const { send, write, recovery, advance } = await setup(),
      draft = input()
    const path = `/api/recovery/${draft.sessionId}`,
      other = randomUUID()
    const receipt = recoveryReceiptSchema.parse(
      JSON.parse((await write(path, draft)).body.toString()),
    )
    expect(Object.keys(receipt).sort()).toEqual(['sourceSha256', 'updatedAt', 'version'])
    expect((await send(path)).status).toBe(409)
    expect(
      (await write(path, { ...draft, ownerId: other, scheme: null, expectedVersion: 1 })).status,
    ).toBe(409)
    expect((await write(path, { ...draft, scheme: null, expectedVersion: 1 })).status).toBe(400)
    if (scheme.source.kind !== 'legacy-html-v1') throw new Error('Expected fictional legacy source')
    const partial = {
      ...scheme,
      source: { kind: scheme.source.kind, importedAt: scheme.source.importedAt },
    }
    const second = await write(path, {
      ...draft,
      expectedVersion: 1,
      scheme: partial,
      sourceSha256: receipt.sourceSha256,
    })
    expect(recoveryReceiptSchema.parse(JSON.parse(second.body.toString())).version).toBe(2)
    expect(
      (await write(path + '/claim', { ownerId: other, expectedVersion: 2 }, 'POST')).status,
    ).toBe(409)
    advance(RECOVERY_LEASE_MS)
    expect(
      (await write(path + '/claim', { ownerId: other, expectedVersion: 2 }, 'POST')).status,
    ).toBe(200)
    expect((await write(path + '/heartbeat', { ownerId: other }, 'POST')).status).toBe(200)
    expect(recovery.get(draft.sessionId)?.version).toBe(3)
    expect((await write(path + '/heartbeat', { ownerId: draft.ownerId }, 'POST')).status).toBe(409)
    expect((await write(path + '/release', { ownerId: draft.ownerId }, 'POST')).status).toBe(200)
    expect((await send(path + `?ownerId=${other}`)).status).toBe(200)
    expect(
      (await write(path, { ownerId: draft.ownerId, expectedVersion: 3 }, 'DELETE')).status,
    ).toBe(409)
    expect((await write(path, { ownerId: other, expectedVersion: 2 }, 'DELETE')).status).toBe(409)
    expect((await write(path, { ownerId: other, expectedVersion: 3 }, 'DELETE')).status).toBe(200)
    expect(JSON.parse((await send('/api/recovery')).body.toString())).toEqual([])
  })

  it('accepts bodies above 64 KiB for project/recovery and keeps a native receipt without source SHA', async () => {
    const { send, write, db } = await setup()
    if (scheme.source.kind !== 'legacy-html-v1') throw new Error('Expected fictional source')
    const large = {
      ...scheme,
      source: { ...scheme.source, originalJson: scheme.source.originalJson + ' '.repeat(100_000) },
    }
    expect(
      (await write(`/api/projects/${scheme.id}`, { scheme: large, expectedRevision: 0 })).status,
    ).toBe(200)
    const draft = input()
    expect(
      (await write(`/api/recovery/${draft.sessionId}`, { ...draft, scheme: large })).status,
    ).toBe(200)
    expect(db.prepare('SELECT COUNT(*) AS count FROM project_sources').get()).toEqual({ count: 1 })
    const native = input()
    const receipt = await write(`/api/recovery/${native.sessionId}`, {
      ...native,
      scheme: { ...scheme, source: { kind: 'created-in-editor' } },
    })
    expect(receipt.status).toBe(200)
    expect(
      Object.keys(recoveryReceiptSchema.parse(JSON.parse(receipt.body.toString()))).sort(),
    ).toEqual(['updatedAt', 'version'])
    expect(JSON.parse((await send(`/api/projects/${scheme.id}`)).body.toString()).scheme).toEqual(
      large,
    )
  })

  it('rolls back source/draft/history when a project revision fails through HTTP', async () => {
    const { write, db, diagnostics } = await setup()
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    db.exec(
      "CREATE TRIGGER reject_project BEFORE INSERT ON project_revisions BEGIN SELECT RAISE(ABORT, 'synthetic revision failure'); END",
    )
    const path = `/api/projects/${scheme.id}`,
      payload = { scheme, expectedRevision: 0 }
    expect((await write(path, payload)).status).toBe(500)
    for (const table of ['project_drafts', 'project_revisions', 'project_sources'])
      expect(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 0 })
    expect(diagnostics.serverError).toHaveBeenCalledTimes(1)
    db.exec('DROP TRIGGER reject_project')
    expect((await write(path, payload)).status).toBe(200)
  })

  it('rolls back recovery/source/lease and pending fields when the atomic save fails', async () => {
    const { write, db, recovery, advance } = await setup(),
      draft = input(),
      path = `/api/recovery/${draft.sessionId}`
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    expect((await write(path, draft)).status).toBe(200)
    const before = db.prepare('SELECT * FROM project_recovery').all(),
      saved = recovery.get(draft.sessionId)
    db.exec(
      "CREATE TRIGGER reject_recovery BEFORE UPDATE ON project_recovery BEGIN SELECT RAISE(ABORT, 'synthetic recovery failure'); END",
    )
    advance(1000)
    if (scheme.source.kind !== 'legacy-html-v1') throw new Error('Expected fictional source')
    const changed = {
      ...scheme,
      source: { ...scheme.source, originalJson: '{"fictional":"changed"}' },
    }
    expect(
      (
        await write(path, {
          ...draft,
          scheme: changed,
          expectedVersion: 1,
          fileName: 'changed.json',
        })
      ).status,
    ).toBe(500)
    expect(db.prepare('SELECT * FROM project_recovery').all()).toEqual(before)
    expect(db.prepare('SELECT COUNT(*) AS count FROM project_sources').get()).toEqual({ count: 1 })
    expect(recovery.get(draft.sessionId)).toEqual(saved)
  })

  it('leaves unmatched requests untouched for fallback and does not call any supplied storage operation', async () => {
    const projects = projectPorts(),
      recovery = recoveryPorts()
    const { send, fallbacks } = await serve([
      createProjectRoutes(projects),
      createRecoveryRoutes(recovery),
    ])
    for (const path of [
      '/api/projects',
      '/api/recovery',
      '/api/pu66',
      `/api/recovery/${randomUUID()}/other`,
      `/api/projects/${scheme.id}/revisions/-1`,
    ]) {
      expect((await send(path, { method: 'POST', headers, body: '{' })).status).toBe(404)
    }
    expect(fallbacks).toHaveLength(5)
    expect(fallbacks.every((state) => !state.read && !state.sent)).toBe(true)
    for (const operation of [...Object.values(projects), ...Object.values(recovery)])
      expect(operation).not.toHaveBeenCalled()
  })

  it('passes one atomic recovery command with unknown Scheme and explicit read access using plain ports', async () => {
    const recovery = recoveryPorts(),
      draft = input()
    const save = vi.mocked(recovery.save)
    save.mockReturnValue({ ...draft, version: 1, updatedAt: record.updatedAt })
    const { send, write } = await serve([createRecoveryRoutes(recovery)])
    const path = `/api/recovery/${draft.sessionId}`
    expect((await write(path, { ...draft, scheme: null })).status).toBe(200)
    const { ownerId, ...transfer } = draft
    expect(save).toHaveBeenCalledExactlyOnceWith({
      input: { ...transfer, scheme: null },
      ownerId,
      sourceSha256: undefined,
    })
    expect((await send(path)).status).toBe(404)
    expect(recovery.get).toHaveBeenLastCalledWith(draft.sessionId, { ownerId: undefined })
    expect((await send(path + `?ownerId=${ownerId}`)).status).toBe(404)
    expect(recovery.get).toHaveBeenLastCalledWith(draft.sessionId, { ownerId })
  })
})
