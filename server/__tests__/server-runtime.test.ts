import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import type { Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { zipSync } from 'fflate'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { importSchemeJson } from '../../src/domain/import'
import { createServerRuntime, type ServerRuntime } from '../server-runtime'
import { createHttpServer } from '../http/server'
import { runImport } from '../import-cli'
import { registerApiShutdown } from '../bootstrap'
import { migrationNotice } from '../database/migration-notice'
import { migrationNotice as compatibleNotice } from '../store'
import { catalogEntry, catalogSource } from './sign-catalog-fixture'
import { documentFile, documentMeta } from './normative-document-fixture'
import { readCard, readEntry } from './pu66-read-fixture'
import { listenHttp } from './http-request-fixture'

const servers: Server[] = [],
  runtimes: ServerRuntime[] = [],
  directories: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const server of servers.splice(0))
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()))
  for (const runtime of runtimes.splice(0)) runtime.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})
function directory() {
  const result = mkdtempSync(join(tmpdir(), 'tod-runtime-'))
  directories.push(result)
  return result
}
function runtime(path = ':memory:') {
  const result = createServerRuntime(path, () => '2030-02-01T12:00:00.000Z')
  runtimes.push(result)
  return result
}
async function serve(app: ServerRuntime) {
  const server = createHttpServer(app.http, 0)
  servers.push(server)
  const http = await listenHttp(server)
  return {
    ...http,
    server,
    write: (path: string, value: unknown, method = 'POST') =>
      http.send(path, {
        method,
        headers: { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1:5173' },
        body: JSON.stringify(value),
      }),
  }
}

describe('production runtime without the storage facade', () => {
  it('shares project/recovery sources and history across HTTP groups and a second connection', async () => {
    const path = join(directory(), 'registry.sqlite'),
      app = runtime(path)
    const { send, write } = await serve(app)
    const scheme = importSchemeJson(readFileSync('tests/fixtures/manual-v1.json', 'utf8')).scheme
    expect(
      (await write('/api/projects/' + scheme.id, { scheme, expectedRevision: 0 }, 'PUT')).status,
    ).toBe(200)
    const input = {
      sessionId: randomUUID(),
      ownerId: randomUUID(),
      scheme,
      expectedVersion: 0,
      baseRevision: 1,
      detailsDraft: null,
      placementDraft: null,
      fileName: 'fictional.json',
    }
    expect((await write('/api/recovery/' + input.sessionId, input, 'PUT')).status).toBe(200)
    expect(
      (await write('/api/projects/' + scheme.id, { scheme, expectedRevision: 0 }, 'PUT')).status,
    ).toBe(409)
    const second = runtime(path)
    expect(second.http.projects.get(scheme.id)?.scheme).toEqual(scheme)
    expect(second.http.projects.listRevisions(scheme.id)).toHaveLength(1)
    expect(second.http.recovery.get(input.sessionId, { ownerId: input.ownerId })?.scheme).toEqual(
      scheme,
    )
    const raw = new DatabaseSync(path, { readOnly: true })
    try {
      expect(raw.prepare('SELECT COUNT(*) AS count FROM project_sources').get()).toEqual({
        count: 1,
      })
    } finally {
      raw.close()
    }
    const report = JSON.parse((await send('/api/diagnostics')).body.toString())
    expect(report.database).toMatchObject({ projects: 1, recoveryCopies: 1, schemaVersion: 13 })
    expect(JSON.stringify(report)).not.toContain(path)
  })

  it('connects import, lifecycle, verification and HTTP projections to one PU-66 state', async () => {
    const app = runtime(),
      entry = readEntry(readCard())
    app.imports.importPu66([entry])
    const { send, write } = await serve(app),
      key = encodeURIComponent(entry.card.key)
    expect(JSON.parse((await send('/api/pu66')).body.toString())).toHaveLength(1)
    expect((await send('/api/pu66/' + key + '/scheme')).status).toBe(200)
    const verification = {
      expectedRevision: 1,
      verifiedAt: '2030-01-30',
      verifiedBy: 'Учебный специалист',
    }
    expect((await write('/api/pu66/' + key + '/verification', verification)).status).toBe(201)
    const input = {
      action: 'exclude' as const,
      keys: [entry.card.key],
      date: '2030-01-30',
      actor: 'Учебный специалист',
      reason: 'closed' as const,
      comment: '',
      successorKey: null,
    }
    const plan = app.http.pu66.lifecycleCommands.planPu66Lifecycle(input)
    app.http.pu66.lifecycleCommands.recordPu66Lifecycle(input, plan.fingerprint)
    expect(JSON.parse((await send('/api/pu66')).body.toString())).toEqual([])
    expect((await write('/api/pu66/' + key + '/verification', verification)).status).toBe(400)
    expect(app.http.pu66.lifecycle.getStatus(entry.card.key)?.excluded).toBe(true)
    expect(app.http.pu66.importCommands.planPu66Import([entry], null).unchanged).toBe(1)
  })

  it('shares documents/text and historical sign references with HTTP image and deletion guards', async () => {
    const app = runtime(),
      file = documentFile()
    const doc = app.http.documents.importCommands.addDocument(
      documentMeta(),
      file.filename,
      file.pdf,
      file.sha256,
    )
    app.http.parameters.saveDocumentText(doc.id, ['Fictional document text'])
    const entry = catalogEntry()
    app.http.signs.importCommands.importSigns([entry], catalogSource({ documentId: doc.id }))
    app.http.signs.importCommands.importSigns([])
    const { send } = await serve(app)
    const image = await send('/api/signs/9.99/image?rev=1')
    expect(image.status).toBe(200)
    expect(image.body).toEqual(Buffer.from(entry.plainPng))
    expect(
      (
        await send('/api/signs/9.99/image?rev=1', {
          headers: { 'If-None-Match': image.headers.etag! },
        })
      ).status,
    ).toBe(304)
    const deletion = await send('/api/documents/' + doc.id, {
      method: 'DELETE',
      headers: { Origin: 'http://127.0.0.1:5173' },
    })
    expect(deletion.status).toBe(409)
    expect(app.http.parameters.getDocumentText(doc.id)).toEqual(['Fictional document text'])
    expect((await send('/api/documents/' + doc.id + '/pdf')).body).toEqual(Buffer.from(file.pdf))
  })

  it('runs sign CLI on narrow runtime commands, preserves no-op and creates a pre-import backup', async () => {
    const path = join(directory(), 'registry.sqlite'),
      app = runtime(path),
      entry = catalogEntry()
    const archive = join(directory(), 'fictional.zip')
    writeFileSync(
      archive,
      zipSync({
        'PNG с номером/9.99.png': entry.numberedPng,
        'PNG без номера/9.99.png': entry.plainPng,
      }),
    )
    expect(await runImport(['signs', archive], app.imports)).toContain('новых 1')
    expect(app.http.signs.catalog.latest()).toBeNull()
    expect(await runImport(['signs', '--apply', archive], app.imports)).toContain('добавлено 1')
    expect(await runImport(['signs', '--apply', archive], app.imports)).toBe(
      'Знаки: данные уже загружены, изменений нет.',
    )
    const files = readdirSync(app.backupDirectory)
    expect(files).toHaveLength(1)
    expect(files[0]).toContain('2030-02-01T12-00-00-000Z')
    const snapshot = new DatabaseSync(join(app.backupDirectory, files[0]!), { readOnly: true })
    try {
      expect(snapshot.prepare('SELECT COUNT(*) AS count FROM sign_catalog_batches').get()).toEqual({
        count: 0,
      })
    } finally {
      snapshot.close()
    }
    expect(app.http.signs.catalog.latest()?.signCount).toBe(1)
  })

  it('gracefully finishes an in-flight API command before closing its connection on SIGTERM', async () => {
    const app = runtime()
    let finish!: (filename: string) => void, started!: () => void
    const pending = new Promise<string>((resolve) => {
      finish = resolve
    })
    const began = new Promise<void>((resolve) => {
      started = resolve
    })
    app.http.createBackup = () => {
      started()
      return pending
    }
    const { server, write } = await serve(app),
      signals = new EventEmitter()
    let closed!: () => void
    const done = new Promise<void>((resolve) => {
      closed = resolve
    })
    const close = vi.fn(() => {
      app.close()
      runtimes.splice(runtimes.indexOf(app), 1)
      closed()
    })
    registerApiShutdown(server, { close }, signals)
    expect(signals.eventNames().sort()).toEqual(['SIGINT', 'SIGTERM'])
    const response = write('/api/backup', {})
    await began
    signals.emit('SIGTERM')
    expect(close).not.toHaveBeenCalled()
    finish('fictional.sqlite')
    expect((await response).status).toBe(201)
    await done
    expect(close).toHaveBeenCalledTimes(1)
    expect(server.listening).toBe(false)
    expect(() => app.schemaVersion()).toThrow()
  })

  it('preserves migration metadata and rejects future databases without changing bytes or creating backups', () => {
    expect(compatibleNotice).toBe(migrationNotice)
    expect(migrationNotice(runtime())).toBeNull()
    const path = join(directory(), 'future.sqlite'),
      db = new DatabaseSync(path)
    db.exec('PRAGMA user_version = 99')
    db.close()
    const before = readFileSync(path)
    expect(() => createServerRuntime(path)).toThrow('Неизвестная версия локальной базы: 99')
    expect(readFileSync(path)).toEqual(before)
    expect(readdirSync(join(path, '..'))).toEqual(['future.sqlite'])
    const reopened = new DatabaseSync(path)
    reopened.close()
  })
})
