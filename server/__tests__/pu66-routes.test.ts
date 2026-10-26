import { createServer, type Server } from 'node:http'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createSampleWorkbook, sampleCards } from '../../scripts/generate-pu66-samples'
import type { Pu66LifecycleWrite } from '../../src/domain/pu66-lifecycle'
import { createServerServices } from '../composition-root'
import { parsePu66, type Pu66Import } from '../pu66'
import { createPu66Routes, type Pu66RouteDependencies } from '../http/routes/pu66'
import { checkRequest } from '../http/security'
import { writeHttpError } from '../http/error-mapper'
import { json } from '../http/json'
import { listenHttp } from './http-request-fixture'
import { readCard, readEntry, PRIVATE_MARKER } from './pu66-read-fixture'

const servers: Server[] = [],
  connections: DatabaseSync[] = []
const headers = { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1:5173' }
let entries: Pu66Import[]
beforeAll(async () => {
  entries = await Promise.all(
    sampleCards
      .slice(0, 2)
      .map(async (card) => parsePu66(await createSampleWorkbook(card), card.filename)),
  )
}, 30000)
afterEach(async () => {
  vi.restoreAllMocks()
  for (const server of servers.splice(0))
    await new Promise<void>((resolve) => server.close(() => resolve()))
  for (const db of connections.splice(0)) db.close()
})
async function serve(dependencies: Pu66RouteDependencies) {
  const route = createPu66Routes(dependencies),
    diagnostics = { serverError: vi.fn() }
  const fallbacks: Array<{ read: boolean; sent: boolean }> = []
  const server = createServer(async (req, res) => {
    try {
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Missing address')
      checkRequest(req, address.port)
      if (await route(req, res, new URL(req.url!, `http://127.0.0.1:${address.port}`))) return
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
    post: (path: string, value: unknown, padding = '') => {
      const body = JSON.stringify(value) + padding
      return http.send(path, {
        method: 'POST',
        headers: { ...headers, 'Content-Length': String(Buffer.byteLength(body)) },
        body,
      })
    },
  }
}
async function setup() {
  const services = createServerServices(':memory:', () => '2030-02-01T12:00:00.000Z')
  connections.push(services.db)
  const backup = vi.fn(async () => 'fictional-backup.sqlite')
  const dependencies: Pu66RouteDependencies = {
    cards: services.pu66,
    lifecycle: services.pu66Lifecycle,
    verifications: services.pu66Verifications,
    lifecycleCommands: {
      planPu66Lifecycle: (input) => services.pu66LifecycleService.plan(input),
      recordPu66Lifecycle: (input, fingerprint) =>
        services.pu66LifecycleService.record(input, fingerprint),
      createBackup: backup,
    },
    importCommands: {
      planPu66Import: (entries, restoration) => services.pu66Imports.preview(entries, restoration),
      importPu66: (entries, restoration) => services.pu66Imports.record(entries, restoration),
      createBackup: backup,
    },
  }
  return { ...services, ...(await serve(dependencies)), dependencies, backup }
}
const exclusion = (keys: string[]): Pu66LifecycleWrite => ({
  action: 'exclude',
  keys,
  date: '2030-01-30',
  actor: 'Учебный специалист',
  reason: 'closed',
  comment: '',
  successorKey: null,
})
const upload = (selected = entries) =>
  selected.map((entry) => ({ name: entry.filename, data: entry.source.toString('base64') }))
const data = (response: { body: Buffer }) => JSON.parse(response.body.toString())

describe('PU-66 routes without RegistryStore', () => {
  it('reads projections/aliases and records verification without exposing private card fields', async () => {
    const { pu66Imports, db, send, post } = await setup(),
      entry = readEntry(readCard())
    pu66Imports.record([entry])
    db.prepare('INSERT INTO pu66_key_aliases VALUES (?, ?)').run('old-single', entry.card.key)
    db.prepare('INSERT INTO pu66_key_aliases VALUES (?, ?)').run('ambiguous', null)
    const scheme = await send('/api/pu66/old-single/scheme'),
      norms = await send('/api/pu66/old-single/norms'),
      list = await send('/api/pu66')
    expect(scheme.status).toBe(200)
    expect(norms.status).toBe(200)
    expect(data(scheme)).toMatchObject({ referenceId: entry.card.key, revision: 1 })
    expect(JSON.stringify([data(scheme), data(norms), data(list)])).not.toContain(PRIVATE_MARKER)
    expect((await send('/api/pu66/ambiguous/scheme')).status).toBe(409)
    const input = {
      expectedRevision: 1,
      verifiedAt: '2030-01-30',
      verifiedBy: 'Учебный специалист',
    }
    const verification = await post('/api/pu66/old-single/verification', input)
    expect(verification.status).toBe(201)
    expect(data(verification)).toMatchObject({ cardRevision: 1, verifiedAt: input.verifiedAt })
    expect(data(await send('/api/pu66/old-single/verifications'))).toHaveLength(1)
    expect(
      (await post('/api/pu66/old-single/verification', { ...input, expectedRevision: 2 })).status,
    ).toBe(409)
    expect(
      (await post('/api/pu66/old-single/verification', { ...input, verifiedAt: '2031-01-30' }))
        .status,
    ).toBe(400)
  })

  it('previews/applies exclusion and restore after backup while keeping source and card revisions', async () => {
    const { pu66Imports, pu66Lifecycle, db, send, post, backup } = await setup(),
      entry = readEntry(readCard())
    pu66Imports.record([entry])
    for (const input of [
      exclusion([entry.card.key]),
      {
        action: 'restore',
        keys: [entry.card.key],
        date: '2030-01-31',
        actor: 'Учебный специалист',
        comment: 'Учебный возврат',
      },
    ]) {
      const plan = await post('/api/pu66/lifecycle/preview', input)
      expect(plan.status).toBe(200)
      const applied = await post('/api/pu66/lifecycle/apply', {
        input,
        expectedFingerprint: data(plan).fingerprint,
      })
      expect(applied.status).toBe(200)
      expect(data(applied)).toEqual({ changed: 1, backup: 'fictional-backup.sqlite' })
      if (input.action === 'exclude') {
        expect(data(await send('/api/pu66'))).toEqual([])
        expect(data(await send('/api/pu66/lifecycle'))[0].status.excluded).toBe(true)
        expect((await send(`/api/pu66/${entry.card.key}/scheme`)).status).toBe(400)
        expect((await send(`/api/pu66/${entry.card.key}/norms`)).status).toBe(200)
      }
    }
    expect(backup).toHaveBeenCalledTimes(2)
    expect(pu66Lifecycle.getStatus(entry.card.key)?.excluded).toBe(false)
    expect(
      data(await send(`/api/pu66/${entry.card.key}/lifecycle`)).map(
        (event: { action: string }) => event.action,
      ),
    ).toEqual(['restore', 'exclude'])
    expect(db.prepare('SELECT revision FROM pu66_cards').get()).toEqual({ revision: 1 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM pu66_sources').get()).toEqual({ count: 1 })
  })

  it('rejects a lifecycle plan changed during backup when the synchronous command rechecks it', async () => {
    const { pu66Imports, pu66Lifecycle, post, backup } = await setup(),
      entry = readEntry(readCard())
    pu66Imports.record([entry])
    const input = exclusion([entry.card.key]),
      plan = data(await post('/api/pu66/lifecycle/preview', input))
    backup.mockImplementationOnce(async () => {
      pu66Imports.record([
        readEntry({ ...entry.card, roadName: 'Изменённая учебная дорога' }, 'changed'),
      ])
      return 'fictional-backup.sqlite'
    })
    const result = await post('/api/pu66/lifecycle/apply', {
      input,
      expectedFingerprint: plan.fingerprint,
    })
    expect(result.status).toBe(409)
    expect(backup).toHaveBeenCalledTimes(1)
    expect(pu66Lifecycle.list(entry.card.key)).toEqual([])
  })

  it('accepts XLSX preview above 64 KiB, applies/no-ops and explicitly restores an excluded card by import', async () => {
    const { send, post, pu66LifecycleService, pu66Lifecycle, backup, db } = await setup()
    const files = upload([entries[0]!])
    const preview = await post('/api/pu66/import/preview', { files }, ' '.repeat(100_000))
    expect(preview.status).toBe(200)
    expect(data(await send('/api/pu66'))).toEqual([])
    expect(
      (await post('/api/pu66/import/apply', { files, expectedFingerprint: '0'.repeat(64) })).status,
    ).toBe(409)
    expect(backup).not.toHaveBeenCalled()
    expect(
      (
        await post('/api/pu66/import/apply', {
          files,
          expectedFingerprint: data(preview).fingerprint,
        })
      ).status,
    ).toBe(200)
    expect(backup).toHaveBeenCalledTimes(1)
    const unchanged = data(await post('/api/pu66/import/preview', { files }))
    expect(
      data(
        await post('/api/pu66/import/apply', { files, expectedFingerprint: unchanged.fingerprint }),
      ),
    ).toEqual({ added: 0, updated: 0, unchanged: 1, restored: 0, backup: null })
    expect(backup).toHaveBeenCalledTimes(1)
    const key = entries[0]!.card.key,
      input = exclusion([key])
    pu66LifecycleService.record(input, pu66LifecycleService.plan(input).fingerprint)
    const restoration = { keys: [key], date: '2030-01-31', actor: 'Учебный специалист' }
    const restorePlan = data(await post('/api/pu66/import/preview', { files, restoration }))
    expect(
      data(
        await post('/api/pu66/import/apply', {
          files,
          restoration,
          expectedFingerprint: restorePlan.fingerprint,
        }),
      ),
    ).toMatchObject({ unchanged: 1, restored: 1, backup: 'fictional-backup.sqlite' })
    expect(backup).toHaveBeenCalledTimes(2)
    expect(pu66Lifecycle.getStatus(key)?.excluded).toBe(false)
    expect(db.prepare('SELECT COUNT(*) AS count FROM pu66_revisions').get()).toEqual({ count: 1 })
  })

  it('rechecks the import fingerprint after backup before calling the write command', async () => {
    const { post, dependencies, pu66Imports, backup, db } = await setup(),
      files = upload([entries[0]!])
    const plan = data(await post('/api/pu66/import/preview', { files }))
    const record = vi.spyOn(dependencies.importCommands, 'importPu66')
    backup.mockImplementationOnce(async () => {
      pu66Imports.record([entries[0]!])
      return 'fictional-backup.sqlite'
    })
    expect(
      (await post('/api/pu66/import/apply', { files, expectedFingerprint: plan.fingerprint }))
        .status,
    ).toBe(409)
    expect(record).not.toHaveBeenCalled()
    expect(db.prepare('SELECT COUNT(*) AS count FROM pu66_revisions').get()).toEqual({ count: 1 })
  })

  it('rolls back every source/card/revision when the second imported book fails through HTTP', async () => {
    const { post, db, backup, diagnostics } = await setup(),
      files = upload()
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const plan = data(await post('/api/pu66/import/preview', { files }))
    db.exec(
      `CREATE TRIGGER reject_import BEFORE INSERT ON pu66_revisions WHEN NEW.key = '${entries[1]!.card.key}' BEGIN SELECT RAISE(ABORT, 'synthetic import failure'); END`,
    )
    expect(
      (await post('/api/pu66/import/apply', { files, expectedFingerprint: plan.fingerprint }))
        .status,
    ).toBe(500)
    for (const table of ['pu66_sources', 'pu66_cards', 'pu66_revisions', 'pu66_lifecycle'])
      expect(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 0 })
    expect(backup).toHaveBeenCalledTimes(1)
    expect(diagnostics.serverError).toHaveBeenCalledTimes(1)
  })

  it('rolls back an entire lifecycle batch if its second event fails after backup', async () => {
    const { pu66Imports, post, db, backup } = await setup()
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    pu66Imports.record(entries)
    const input = exclusion(entries.map((entry) => entry.card.key)),
      plan = data(await post('/api/pu66/lifecycle/preview', input))
    db.exec(
      `CREATE TRIGGER reject_lifecycle BEFORE INSERT ON pu66_lifecycle WHEN NEW.key = '${entries[1]!.card.key}' BEGIN SELECT RAISE(ABORT, 'synthetic lifecycle failure'); END`,
    )
    expect(
      (await post('/api/pu66/lifecycle/apply', { input, expectedFingerprint: plan.fingerprint }))
        .status,
    ).toBe(500)
    expect(db.prepare('SELECT COUNT(*) AS count FROM pu66_lifecycle').get()).toEqual({ count: 0 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM pu66_cards').get()).toEqual({ count: 2 })
    expect(backup).toHaveBeenCalledTimes(1)
  })

  it('leaves unmatched requests untouched without calling any supplied operation', async () => {
    const unused = () => {
      throw new Error('Unused operation')
    }
    const dependencies: Pu66RouteDependencies = {
      cards: { list: vi.fn(() => []), getNorms: vi.fn(() => null), getScheme: vi.fn(() => null) },
      lifecycle: { getStatus: vi.fn(() => null), list: vi.fn(() => null) },
      verifications: { list: vi.fn(() => null), record: vi.fn(() => null) },
      lifecycleCommands: {
        planPu66Lifecycle: vi.fn(unused),
        recordPu66Lifecycle: vi.fn(unused),
        createBackup: vi.fn(async () => 'unused'),
      },
      importCommands: {
        planPu66Import: vi.fn(unused),
        importPu66: vi.fn(unused),
        createBackup: vi.fn(async () => 'unused'),
      },
    }
    const { send, fallbacks } = await serve(dependencies)
    for (const [path, method] of [
      ['/api/signs', 'POST'],
      ['/api/pu66/', 'GET'],
      ['/api/pu66/missing/status/extra', 'GET'],
      ['/api/pu66/missing/norms', 'POST'],
      ['/api/pu66/lifecycle/preview', 'GET'],
    ] as const)
      expect(
        (await send(path, { method, headers: { ...headers, 'Content-Length': '1' }, body: '{' }))
          .status,
      ).toBe(404)
    expect(fallbacks).toHaveLength(5)
    expect(fallbacks.every((state) => !state.read && !state.sent)).toBe(true)
    for (const area of Object.values(dependencies))
      for (const operation of Object.values(area)) expect(operation).not.toHaveBeenCalled()
  })
})
