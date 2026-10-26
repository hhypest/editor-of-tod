import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Server } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRegistryServer } from '../index'
import { DiagnosticsLog } from '../diagnostics'
import { RegistryStore } from '../store'
import { listenHttp } from './http-request-fixture'

const servers: Server[] = [],
  stores: RegistryStore[] = [],
  directories: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const server of servers.splice(0))
    await new Promise<void>((resolve) => server.close(() => resolve()))
  for (const store of stores.splice(0)) store.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})
async function setup(path = ':memory:') {
  const store = new RegistryStore(path)
  stores.push(store)
  const diagnostics = new DiagnosticsLog(null, { version: 'test', mode: 'test' })
  const instanceId = randomUUID()
  const server = createRegistryServer(store, 0, undefined, diagnostics, instanceId)
  servers.push(server)
  const http = await listenHttp(server)
  return {
    store,
    diagnostics,
    instanceId,
    ...http,
    write: (path: string, value: unknown, method = 'POST') =>
      http.send(path, {
        method,
        headers: { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1:5173' },
        body: JSON.stringify(value),
      }),
  }
}

/** Run on the original index before extracting the remaining route groups. */
describe('system/diagnostics/legacy compatibility contracts', () => {
  it('keeps status identity, probe validation and memory semantics without exposing paths', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'tod-system-contract-'))
    directories.push(directory)
    const path = join(directory, 'fictional.sqlite')
    const { send, instanceId } = await setup(path)
    const probe = 'abcdefab-cdef-4abc-8def-abcdefabcdef'
    const read = async (query = '') =>
      JSON.parse((await send('/api/status' + query)).body.toString())
    const status = await read()
    expect(status).toEqual({
      application: 'editor-of-tod',
      ready: true,
      databaseId: expect.stringMatching(/^[a-f0-9]{64}$/),
      instanceId,
    })
    expect(await read('?probe=' + probe)).toEqual({ ...status, probe: false })
    writeFileSync(path + '.probe-' + probe, '')
    expect(await read('?probe=' + probe)).toEqual({ ...status, probe: true })
    for (const invalid of ['../private', probe.toUpperCase(), '', probe + '-extra'])
      expect(await read('?probe=' + encodeURIComponent(invalid))).toEqual(status)
    const memory = await setup()
    expect(
      JSON.parse((await memory.send('/api/status?probe=' + probe)).body.toString()),
    ).not.toHaveProperty('probe')
    expect(JSON.stringify(status)).not.toContain(directory)
    expect((await send('/api/status', { method: 'HEAD' })).status).toBe(404)
  })

  it('keeps diagnostic report exclusion, isolated query failures, events and clear finish statistics', async () => {
    const { store, diagnostics, send, write } = await setup()
    vi.spyOn(store, 'listProjects').mockImplementation(() => {
      throw new Error('PRIVATE')
    })
    const report = async () => JSON.parse((await send('/api/diagnostics')).body.toString())
    expect((await report()).requests).toEqual([])
    expect((await report()).requests).toEqual([])
    expect((await report()).database).toMatchObject({
      location: 'память',
      sizeKb: 0,
      schemaVersion: 13,
      projects: 'недоступно',
      documents: 0,
      signCatalog: null,
    })
    expect((await write('/api/diagnostics/events', { events: [] })).status).toBe(400)
    expect(
      (
        await write('/api/diagnostics/events', {
          events: [{ kind: 'event', name: 'PRIVATE', message: 'PRIVATE' }],
        })
      ).status,
    ).toBe(200)
    expect(JSON.stringify(await report())).not.toContain('PRIVATE')
    const before = diagnostics.report(store)
    expect(before.eventsTotal).toBeGreaterThan(0)
    expect((await write('/api/diagnostics/clear', {})).status).toBe(200)
    expect(await report()).toMatchObject({
      events: [],
      eventsTotal: 0,
      requests: [{ route: 'POST /api/diagnostics/clear', count: 1, errors: 0 }],
    })
  })

  it('preserves legacy validation, unchanged revisions, conflicts, list and backup responses', async () => {
    const { store, send, write } = await setup()
    const crossing = {
      referenceId: ' fictional ',
      railwayLocation: '',
      roadName: '',
      roadOwner: '',
      cardReference: '',
      cardUpdatedAt: '',
      verifiedAt: '',
      notes: ' учебный ',
    }
    expect(
      (await write('/api/crossings', { ...crossing, expectedRevision: 0 }, 'PUT')).status,
    ).toBe(200)
    const first = JSON.parse((await send('/api/crossings')).body.toString())[0]
    expect(first).toMatchObject({ referenceId: 'fictional', notes: 'учебный', revision: 1 })
    expect(
      (await write('/api/crossings', { ...crossing, expectedRevision: 1 }, 'PUT')).status,
    ).toBe(200)
    expect(
      (await write('/api/crossings', { ...crossing, expectedRevision: 1 }, 'PUT')).status,
    ).toBe(409)
    expect((await write('/api/normative', { expectedRevision: 0 }, 'PUT')).status).toBe(400)
    const entry = store.listNormative()[0]!
    const { revision, updatedAt: _updatedAt, ...draft } = entry
    void _updatedAt
    expect(
      (await write('/api/normative', { ...draft, expectedRevision: revision }, 'PUT')).status,
    ).toBe(200)
    expect(
      (await write('/api/normative', { ...draft, expectedRevision: revision }, 'PUT')).status,
    ).toBe(409)
    vi.spyOn(store, 'createBackup').mockResolvedValue('fictional-backup.sqlite')
    const backup = await write('/api/backup', {})
    expect(backup.status).toBe(201)
    expect(JSON.parse(backup.body.toString())).toEqual({ filename: 'fictional-backup.sqlite' })
    expect(backup.headers['cache-control']).toBe('no-store')
    expect((await write('/api/crossings/fictional', crossing, 'PUT')).status).toBe(404)
  })
})
