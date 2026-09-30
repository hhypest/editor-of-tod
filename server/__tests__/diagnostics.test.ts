import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import type { Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createSampleWorkbook, sampleCards } from '../../scripts/generate-pu66-samples'
import { DiagnosticsLog, redact, routeOf } from '../diagnostics'
import { createRegistryServer } from '../index'
import { RegistryStore } from '../store'

const servers: Server[] = []
const stores: RegistryStore[] = []
const directories: string[] = []
afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  )
  for (const store of stores.splice(0)) store.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('diagnostics without confidential data', () => {
  it('removes PU-66 keys, phones and full names from messages', () => {
    const text = redact(
      'Карточка 90002:24:7 и ст.Озёрная:53:2; тел. 8 910 123-45-67; Учебный А.Б., В.Г. Учебная, Учебный Иван Петрович',
    )
    expect(text).not.toMatch(/90002|Озёрная|910|Учебн/u)
    expect(text).toContain('<ключ ПУ-66>')
    expect(text).toContain('<телефон>')
    expect(text).toContain('<ФИО>')
  })

  it('generalises request paths so keys and ids never reach the log', () => {
    expect(routeOf('GET', '/api/pu66/90002%3A24%3A7/norms')).toBe('GET /api/pu66/:key/norms')
    expect(routeOf('POST', '/api/pu66/import/apply')).toBe('POST /api/pu66/import/apply')
    expect(routeOf('GET', `/api/projects/${crypto.randomUUID()}/revisions/3`)).toBe(
      'GET /api/projects/:id/revisions/:n',
    )
    expect(routeOf('GET', '/api/documents/4/pdf')).toBe('GET /api/documents/:id/pdf')
    expect(routeOf('GET', '/assets/index.js')).toBe('GET (интерфейс)')
  })

  it('keeps the log in a file across restarts and rotates it', () => {
    const directory = mkdtempSync(join(tmpdir(), 'tod-diagnostics-'))
    directories.push(directory)
    const file = join(directory, 'diagnostics.jsonl')
    const log = new DiagnosticsLog(file, { version: 'test', mode: 'test' })
    log.request('GET /api/signs', 200, 5)
    log.request('GET /api/signs', 200, 2_000)
    log.request('POST /api/pu66/import/apply', 400, 10)
    log.serverError('GET /api/diagnostics', new Error('Сбой у 90002:24:7'))
    const reopened = new DiagnosticsLog(file, { version: 'test', mode: 'test' })
    const store = new RegistryStore(':memory:')
    stores.push(store)
    const events = reopened.report(store).events as Array<{ kind: string; message?: string }>
    expect(events.map((event) => event.kind)).toEqual(['slow', 'error', 'error'])
    expect(readFileSync(file, 'utf8')).not.toContain('90002')
    for (let index = 0; index < 1_100; index++)
      reopened.record({ source: 'client', kind: 'event', name: `событие ${index}` })
    expect(readFileSync(file, 'utf8').trim().split('\n').length).toBeLessThanOrEqual(1_000)
    reopened.clear()
    expect(readFileSync(file, 'utf8')).toBe('')
  })

  it('serves a report with counts only and accepts client events from the local interface', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'tod-diagnostics-api-'))
    directories.push(directory)
    const store = new RegistryStore(join(directory, 'registry.sqlite'))
    stores.push(store)
    const card = sampleCards[1]!
    const file = {
      name: card.filename,
      data: (await createSampleWorkbook(card)).toString('base64'),
    }
    const log = new DiagnosticsLog(null, { version: 'test', mode: 'test' })
    const server = createRegistryServer(store, 0, undefined, log)
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Server address missing')
    const base = `http://127.0.0.1:${address.port}`
    const headers = { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1:5173' }
    const plan = (await (
      await fetch(`${base}/api/pu66/import/preview`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ files: [file] }),
      })
    ).json()) as { fingerprint: string }
    await fetch(`${base}/api/pu66/import/apply`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ files: [file], expectedFingerprint: plan.fingerprint }),
    })
    await fetch(`${base}/api/pu66/${encodeURIComponent('90002:24:7')}/norms`)
    await fetch(`${base}/api/pu66/${encodeURIComponent('90002:99:9')}/scheme`)

    const accepted = await fetch(`${base}/api/diagnostics/events`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        events: [{ kind: 'error', name: 'Ошибка Vue', message: 'Учебный А.Б. 90002:24:7' }],
      }),
    })
    expect(accepted.status).toBe(200)
    const foreign = await fetch(`${base}/api/diagnostics/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'http://example.com' },
      body: JSON.stringify({ events: [{ kind: 'event', name: 'чужой сайт' }] }),
    })
    expect(foreign.status).toBe(403)

    const report = (await (await fetch(`${base}/api/diagnostics`)).json()) as {
      database: unknown
      requests: unknown
      events: unknown
    }
    expect(report.database).toMatchObject({ pu66Cards: 1, projects: 0 })
    const text = JSON.stringify(report)
    for (const secret of ['90002', 'Учебная дорога', 'Условная станция', 'Учебный'])
      expect(text).not.toContain(secret)
    expect(report.requests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ route: 'GET /api/pu66/:key/scheme', errors: 1 }),
      ]),
    )
    expect(report.events).toEqual(
      expect.arrayContaining([expect.objectContaining({ source: 'client', name: 'Ошибка Vue' })]),
    )
  })
})
