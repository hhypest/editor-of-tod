import { randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServerServices } from '../composition-root'
import { databaseSummary, type DiagnosticDatabaseQueries } from '../diagnostic-database'
import { DiagnosticsLog } from '../diagnostics'
import { createSystemRoutes } from '../http/routes/system'
import { createDiagnosticRoutes } from '../http/routes/diagnostics'
import { createLegacyRoutes } from '../http/routes/legacy'
import type { RouteHandler } from '../http/route'
import { checkRequest } from '../http/security'
import { writeHttpError } from '../http/error-mapper'
import { json } from '../http/json'
import { listenHttp } from './http-request-fixture'

const servers: Server[] = [],
  connections: DatabaseSync[] = [],
  directories: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const server of servers.splice(0))
    await new Promise<void>((resolve) => server.close(() => resolve()))
  for (const db of connections.splice(0)) db.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})
function directory() {
  const path = mkdtempSync(join(tmpdir(), 'tod-system-routes-'))
  directories.push(path)
  return path
}
const crossing = {
  referenceId: 'shared-test',
  railwayLocation: 'Учебный участок',
  roadName: '',
  roadOwner: '',
  cardReference: '',
  cardUpdatedAt: '',
  verifiedAt: '',
  notes: '',
}
const normative = {
  id: 'shared-test',
  documentCode: 'УЧЕБНЫЙ',
  edition: '2030',
  clause: '1',
  description: 'Вымышленный источник',
  application: '',
  sourceUrl: '',
  reviewStatus: 'needs-review' as const,
  checkedAt: '',
  reviewer: '',
}
function queries(
  path = ':memory:',
  backupDirectory = join(directory(), 'backups'),
): DiagnosticDatabaseQueries {
  return {
    path,
    backupDirectory,
    schemaVersion: () => 13,
    listPu66: () => [{ secret: 'PRIVATE' }],
    listProjects: () => [{ secret: 'PRIVATE' }, {}],
    listRecoveries: () => [],
    listDocuments: () => [],
    listParameterConfirmations: () => [],
    latestSignCatalog: () => ({
      signCount: 7,
      documentId: 3,
      importedAt: '2030-01-01T00:00:00.000Z',
      secret: 'PRIVATE',
    }),
  }
}
async function serve(
  routes: RouteHandler[],
  log = new DiagnosticsLog(null, { version: 'test', mode: 'test' }),
) {
  const fallbacks: Array<{ read: boolean; sent: boolean }> = []
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
      writeHttpError(res, error, 'test route', log)
    }
  })
  servers.push(server)
  const http = await listenHttp(server)
  return {
    ...http,
    fallbacks,
    write: (path: string, value: unknown, method = 'POST') =>
      http.send(path, {
        method,
        headers: { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1:5173' },
        body: JSON.stringify(value),
      }),
  }
}
function services(path = ':memory:') {
  const result = createServerServices(path, () => '2030-01-01T00:00:00.000Z')
  connections.push(result.db)
  return result
}

describe('system/diagnostics/legacy groups without the storage facade', () => {
  it('answers status using the exact probe allowlist and preserves backup await/status/headers', async () => {
    const path = join(directory(), 'fictional.sqlite'),
      probe = randomUUID()
    writeFileSync(path + '.probe-' + probe, '')
    const createBackup = vi.fn(async () => 'fictional-backup.sqlite')
    const { send, write } = await serve([
      createSystemRoutes({
        databasePath: path,
        databaseId: 'db-id',
        instanceId: 'instance-id',
        createBackup,
      }),
    ])
    const expected = {
      application: 'editor-of-tod',
      ready: true,
      databaseId: 'db-id',
      instanceId: 'instance-id',
    }
    expect(JSON.parse((await send('/api/status?probe=' + probe)).body.toString())).toEqual({
      ...expected,
      probe: true,
    })
    expect(JSON.parse((await send('/api/status?probe=' + randomUUID())).body.toString())).toEqual({
      ...expected,
      probe: false,
    })
    expect(JSON.parse((await send('/api/status?probe=../private')).body.toString())).toEqual(
      expected,
    )
    const response = await write('/api/backup', 'body is ignored')
    expect(response.status).toBe(201)
    expect(JSON.parse(response.body.toString())).toEqual({ filename: 'fictional-backup.sqlite' })
    expect(response.headers).toMatchObject({
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    })
    expect(createBackup).toHaveBeenCalledExactlyOnceWith()
  })

  it('projects summary counts/catalog metadata only, observes live queries with the original projection', () => {
    const path = join(directory(), 'fictional.sqlite'),
      backupDirectory = join(directory(), 'backups')
    writeFileSync(path, Buffer.alloc(2048))
    mkdirSync(backupDirectory)
    writeFileSync(join(backupDirectory, 'fictional.sqlite'), '')
    const source = queries(path, backupDirectory)
    const summary = databaseSummary(source)
    expect(summary).toEqual({
      location: 'локальная база',
      sizeKb: 2,
      schemaVersion: 13,
      pu66Cards: 1,
      projects: 2,
      recoveryCopies: 0,
      documents: 0,
      parameterConfirmations: 0,
      signCatalog: { signCount: 7, fromPdf: true, importedAt: '2030-01-01T00:00:00.000Z' },
      backups: 1,
    })
    expect(JSON.stringify(summary)).not.toMatch(/PRIVATE|fictional|shared-test/)
    expect(JSON.stringify(summary)).not.toContain(path)
    source.listProjects = () => []
    source.latestSignCatalog = () => null
    expect(databaseSummary(source)).toMatchObject({ projects: 0, signCatalog: null })
    source.latestSignCatalog = () => ({ signCount: 1, documentId: null, importedAt: '2030' })
    expect(databaseSummary(source).signCatalog).toEqual({
      signCount: 1,
      fromPdf: false,
      importedAt: '2030',
    })
  })

  it('isolates every failed diagnostic query and filesystem read without exposing its error', () => {
    const badBackups = join(directory(), 'not-a-directory')
    writeFileSync(badBackups, '')
    const source = queries(join(directory(), 'missing.sqlite'), badBackups)
    const fail = () => {
      throw new Error('PRIVATE')
    }
    source.schemaVersion = fail
    source.listPu66 = fail
    source.listProjects = fail
    source.listRecoveries = fail
    source.listDocuments = fail
    source.listParameterConfirmations = fail
    source.latestSignCatalog = fail
    expect(databaseSummary(source)).toEqual({
      location: 'локальная база',
      sizeKb: 'недоступно',
      schemaVersion: 'недоступно',
      pu66Cards: 'недоступно',
      projects: 'недоступно',
      recoveryCopies: 'недоступно',
      documents: 'недоступно',
      parameterConfirmations: 'недоступно',
      signCatalog: 'недоступно',
      backups: 'недоступно',
    })
    source.listProjects = () => [{}]
    expect(databaseSummary(source).projects).toBe(1)
    expect(databaseSummary(queries())).toMatchObject({ location: 'память', sizeKb: 0, backups: 0 })
  })

  it('keeps diagnostic event validation, byte limits, sanitization and journal clearing', async () => {
    const logFile = join(directory(), 'diagnostics.jsonl')
    const log = new DiagnosticsLog(logFile, { version: 'test', mode: 'test' })
    const source = queries()
    const { send, write } = await serve(
      [
        createDiagnosticRoutes({
          report: () => log.report(source),
          record: (event) => log.record(event),
          clear: () => log.clear(),
        }),
      ],
      log,
    )
    expect((await write('/api/diagnostics/events', { events: [] })).status).toBe(400)
    const body = JSON.stringify({
      events: [
        {
          kind: 'error',
          name: 'PRIVATE',
          message: 'PRIVATE',
          frames: ['C:\\PRIVATE\\unknown.ts:1:1'],
          errorType: 'TypeError',
        },
      ],
    })
    const post = (value: string, type = 'application/json') =>
      send('/api/diagnostics/events', {
        method: 'POST',
        headers: { 'Content-Type': type, Origin: 'http://127.0.0.1:5173' },
        body: value,
      })
    const exact = body + ' '.repeat(64 * 1024 - Buffer.byteLength(body))
    expect((await post(exact)).status).toBe(200)
    expect((await post(exact + ' ')).status).toBe(413)
    expect((await post('{')).status).toBe(400)
    expect((await post(body, 'text/plain')).status).toBe(415)
    const report = JSON.parse((await send('/api/diagnostics')).body.toString())
    expect(report).toMatchObject({
      kind: 'editor-of-tod-diagnostics',
      formatVersion: 2,
      eventsTotal: 1,
    })
    expect(JSON.stringify(report)).not.toContain('PRIVATE')
    expect((await write('/api/diagnostics/clear', {})).status).toBe(200)
    expect(
      new DiagnosticsLog(logFile, { version: 'test', mode: 'test' }).report(source).eventsTotal,
    ).toBe(0)
  })

  it('saves both manual registries through their repository with trimming, new versions and independent history', async () => {
    const { legacy } = services()
    const { send, write } = await serve([createLegacyRoutes(legacy)])
    for (const [kind, draft] of [
      ['crossings', crossing],
      ['normative', normative],
    ] as const) {
      for (const revision of [0, 1]) {
        const response = await write(
          '/api/' + kind,
          { ...draft, expectedRevision: revision },
          'PUT',
        )
        expect(response.status).toBe(200)
        expect(JSON.parse(response.body.toString())).toMatchObject({
          ...draft,
          revision: revision + 1,
          updatedAt: '2030-01-01T00:00:00.000Z',
        })
      }
      expect((await write('/api/' + kind, { ...draft, expectedRevision: 1 }, 'PUT')).status).toBe(
        409,
      )
      expect(
        (await write('/api/' + kind, { ...draft, extra: true, expectedRevision: 2 }, 'PUT')).status,
      ).toBe(400)
      expect((await write('/api/' + kind, { ...draft, expectedRevision: -1 }, 'PUT')).status).toBe(
        400,
      )
      expect(legacy.history(kind, 'shared-test').map((row) => row.revision)).toEqual([1, 2])
      expect(JSON.parse((await send('/api/' + kind)).body.toString())).toEqual(
        kind === 'crossings' ? legacy.listCrossings() : legacy.listNormative(),
      )
    }
    expect(
      (
        await write(
          '/api/normative',
          { ...normative, reviewStatus: 'checked', expectedRevision: 2 },
          'PUT',
        )
      ).status,
    ).toBe(400)
    const trimmed = await write(
      '/api/crossings',
      { ...crossing, referenceId: ' shared-test ', notes: ' учебный ', expectedRevision: 2 },
      'PUT',
    )
    expect(JSON.parse(trimmed.body.toString())).toMatchObject({
      referenceId: 'shared-test',
      notes: 'учебный',
      revision: 3,
    })
  })

  it('keeps cross-connection conflicts and rolls back both kinds when history insertion fails', async () => {
    const path = join(directory(), 'fictional.sqlite'),
      first = services(path),
      second = services(path)
    const { write } = await serve([createLegacyRoutes(first.legacy)])
    for (const [kind, draft] of [
      ['crossings', crossing],
      ['normative', normative],
    ] as const) {
      if (kind === 'crossings') second.legacy.saveCrossing(crossing, 0)
      else second.legacy.saveNormative(normative, 0)
      expect((await write('/api/' + kind, { ...draft, expectedRevision: 0 }, 'PUT')).status).toBe(
        409,
      )
      first.db.exec(
        `CREATE TRIGGER reject_history BEFORE INSERT ON revisions WHEN NEW.kind = '${kind}' BEGIN SELECT RAISE(ABORT, 'fictional failure'); END`,
      )
      vi.spyOn(console, 'error').mockImplementation(() => {})
      expect((await write('/api/' + kind, { ...draft, expectedRevision: 1 }, 'PUT')).status).toBe(
        500,
      )
      expect(first.legacy.history(kind, 'shared-test').map((row) => row.revision)).toEqual([1])
      expect(
        (kind === 'crossings' ? second.legacy.listCrossings() : second.legacy.listNormative()).find(
          (row) => ('referenceId' in row ? row.referenceId : row.id) === 'shared-test',
        )?.revision,
      ).toBe(1)
      first.db.exec('DROP TRIGGER reject_history')
      expect((await write('/api/' + kind, { ...draft, expectedRevision: 1 }, 'PUT')).status).toBe(
        200,
      )
    }
  })

  it('leaves unmatched paths and methods untouched for the outer fallback, including request bodies', async () => {
    const source = queries(),
      log = new DiagnosticsLog(null, { version: 'test', mode: 'test' })
    const createBackup = vi.fn(async () => 'unused')
    const { legacy } = services()
    const { write, fallbacks } = await serve([
      createSystemRoutes({
        databasePath: ':memory:',
        databaseId: 'id',
        instanceId: 'instance',
        createBackup,
      }),
      createDiagnosticRoutes({
        report: () => log.report(source),
        record: (event) => log.record(event),
        clear: () => log.clear(),
      }),
      createLegacyRoutes(legacy),
    ])
    for (const path of [
      '/api/status',
      '/api/status/extra',
      '/api/diagnostics',
      '/api/diagnostics/events/extra',
      '/api/crossings',
      '/api/normative/extra',
      '/api/backup/extra',
      '/api/projects',
    ]) {
      const response = await write(path, {}, 'PATCH')
      expect(response.status).toBe(404)
      expect(JSON.parse(response.body.toString())).toEqual({ fallback: true })
    }
    expect(fallbacks).toEqual(Array.from({ length: 8 }, () => ({ read: false, sent: false })))
    expect(createBackup).not.toHaveBeenCalled()
  })
})
