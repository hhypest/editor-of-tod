import type { Server } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createRegistryServer, type StaticFiles } from '../index'
import { RegistryStore } from '../store'
import { DiagnosticsLog } from '../diagnostics'
import { RevisionConflict, RecoveryOwned, ProjectTooLarge } from '../storage-errors'
import {
  AmbiguousPu66Key,
  InvalidPu66Lifecycle,
  InvalidPu66Verification,
  InvalidPu66Upload,
} from '../pu66/errors'
import { InvalidSignUpload } from '../sign-web-import'
import { InvalidDocumentUpload } from '../document-web-import'
import { DocumentInUse } from '../documents/errors'
import { InvalidParameter, ParameterConfirmationConflict } from '../normative-parameters'
import { catalogEntry } from './sign-catalog-fixture'
import { documentFile, documentMeta } from './normative-document-fixture'
import { listenHttp } from './http-request-fixture'

const servers: Server[] = [],
  stores: RegistryStore[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const server of servers.splice(0))
    await new Promise<void>((resolve) => server.close(() => resolve()))
  for (const store of stores.splice(0)) store.close()
})
async function setup(files?: StaticFiles) {
  const store = new RegistryStore(':memory:')
  stores.push(store)
  const diagnostics = new DiagnosticsLog(null, { version: 'test', mode: 'test' })
  const server = createRegistryServer(store, 0, files, diagnostics)
  servers.push(server)
  return { store, diagnostics, ...(await listenHttp(server)) }
}
const eventBody = JSON.stringify({ events: [{ kind: 'event', name: 'app.start' }] })
const localHeaders = { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1:5173' }

/** These checks first run against the unchanged handler before extraction. */
describe('HTTP contracts through createRegistryServer', () => {
  it('keeps Host/Origin rules and checks security before body validation', async () => {
    const { port, send } = await setup()
    for (const host of ['example.invalid', '127.0.0.1', `127.0.0.1:${port + 1}`]) {
      const response = await send('/api/crossings', { headers: { Host: host } })
      expect(response.status).toBe(403)
      expect(JSON.parse(response.body.toString())).toEqual({
        error: 'Допускается только локальное обращение.',
      })
    }
    expect(
      (
        await send('/api/crossings', {
          headers: { Host: `localhost:${port}`, Origin: 'https://example.invalid' },
        })
      ).status,
    ).toBe(200)
    for (const origin of ['', 'null', 'https://example.invalid', `http://127.0.0.1:${port + 1}`]) {
      const response = await send('/api/diagnostics/events', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain', ...(origin ? { Origin: origin } : {}) },
        body: '{',
      })
      expect(response.status).toBe(403)
      expect(JSON.parse(response.body.toString())).toEqual({
        error: 'Запись доступна только из локального интерфейса.',
      })
    }
    for (const origin of [
      `http://127.0.0.1:${port}`,
      `http://localhost:${port}`,
      'http://127.0.0.1:5173',
      'http://localhost:5173',
      'http://127.0.0.1:4173',
      'http://localhost:4173',
    ]) {
      const response = await send('/api/diagnostics/events', {
        method: 'POST',
        headers: { ...localHeaders, Origin: origin },
        body: eventBody,
      })
      expect(response.status).toBe(200)
    }
    expect((await send('/api/status', { method: 'HEAD' })).status).toBe(404)
    expect((await send('/api/status', { method: 'OPTIONS' })).status).toBe(403)
  })

  it('keeps content-type policy, malformed JSON errors and the exact byte limit', async () => {
    const { send } = await setup()
    const post = (body: string, type = 'application/json') =>
      send('/api/diagnostics/events', {
        method: 'POST',
        headers: { ...localHeaders, 'Content-Type': type },
        body,
      })
    expect((await post(eventBody, 'application/json; charset=utf-8')).status).toBe(200)
    expect((await post('{', 'text/plain')).status).toBe(415)
    expect((await post(eventBody, 'Application/JSON')).status).toBe(415)
    const malformed = await post('{')
    expect(malformed.status).toBe(400)
    expect(JSON.parse(malformed.body.toString())).toEqual({
      error: 'Программа не смогла прочитать данные. Перезапустите её и повторите действие.',
    })
    const exact = eventBody + ' '.repeat(64 * 1024 - Buffer.byteLength(eventBody))
    expect((await post(exact)).status).toBe(200)
    expect((await post(exact + ' ')).status).toBe(413)
  })

  it('keeps malformed encoding, UUID validation and method-specific fallback errors', async () => {
    const { send } = await setup()
    for (const [path, status, error] of [
      ['/api/projects/%ZZ', 400, 'Неверный код в адресе.'],
      ['/api/projects/not-a-uuid', 400, 'Неверный ID проекта.'],
      ['/api/projects/00000000-0000-4000-8000-000000000000', 404, 'Проект не найден.'],
      ['/api/not-found', 404, 'Адрес не найден.'],
    ] as const) {
      const response = await send(path)
      expect(response.status).toBe(status)
      expect(JSON.parse(response.body.toString())).toEqual({ error })
    }
    const method = await send('/api/documents/1/pdf', { method: 'POST', headers: localHeaders })
    expect(method.status).toBe(405)
    expect(JSON.parse(method.body.toString())).toEqual({ error: 'Метод не поддерживается.' })
  })

  it('keeps the static allowlist, MIME types and missing-file errors', async () => {
    const files = vi.fn(async (name: string) => {
      if (name === 'assets/missing.js') throw new Error('synthetic missing file')
      return Buffer.from(`fictional:${name}`)
    })
    const { send } = await setup(files)
    for (const [path, filename, type] of [
      ['/', 'index.html', 'text/html'],
      ['/index.html', 'index.html', 'text/html'],
      ['/favicon.svg', 'favicon.svg', 'image/svg+xml'],
      ['/assets/app.js?x=1', 'assets/app.js', 'text/javascript'],
      ['/assets/app.css', 'assets/app.css', 'text/css'],
      ['/legal/THIRD_PARTY_LICENSES.txt', 'legal/THIRD_PARTY_LICENSES.txt', 'text/plain'],
      ['/legal/third-party.json', 'legal/third-party.json', 'application/json'],
    ]) {
      const response = await send(path!)
      expect(response.status).toBe(200)
      expect(response.headers['content-type']).toBe(`${type}; charset=utf-8`)
      expect(response.headers['cache-control']).toBe('no-store')
      expect(response.headers['x-content-type-options']).toBe('nosniff')
      expect(response.body.toString()).toBe(`fictional:${filename}`)
    }
    for (const path of [
      '/assets/subdir/app.js',
      '/assets/%2Fprivate.js',
      '/private.sqlite',
      '/legal/other.txt',
    ]) {
      files.mockClear()
      const response = await send(path)
      expect(response.status).toBe(404)
      expect(files).not.toHaveBeenCalled()
      expect(JSON.parse(response.body.toString())).toEqual({ error: 'Страница не найдена.' })
    }
    const missing = await send('/assets/missing.js')
    expect(missing.status).toBe(404)
    expect(JSON.parse(missing.body.toString())).toEqual({
      error: 'Файлы интерфейса не найдены. Переустановите программу и повторите запуск.',
    })
    const unsupported = await send('/assets/app.woff')
    expect(unsupported.status).toBe(404)
    expect(JSON.parse(unsupported.body.toString())).toEqual({ error: 'Файл не найден.' })
  })

  it('keeps PDF bytes/filename and PNG cache/security headers including wildcard ETag', async () => {
    const { store, send } = await setup()
    const file = documentFile(),
      filename = 'Учебный документ.pdf'
    const document = store.addDocument(documentMeta(), filename, file.pdf, file.sha256)
    const pdf = await send(`/api/documents/${document.id}/pdf`)
    expect(pdf.headers['content-type']).toBe('application/pdf')
    expect(pdf.headers['content-disposition']).toBe(
      `inline; filename*=UTF-8''${encodeURIComponent(filename)}`,
    )
    expect(pdf.headers['cache-control']).toBe('no-store')
    expect(pdf.body).toEqual(file.pdf)
    const entry = catalogEntry()
    store.importSigns([entry])
    const image = await send(`/api/signs/${entry.code}/image`)
    expect(image.body).toEqual(entry.plainPng)
    expect(image.headers['content-type']).toBe('image/png')
    expect(image.headers['cross-origin-resource-policy']).toBe('same-origin')
    expect(image.headers['content-security-policy']).toBe("default-src 'none'; sandbox")
    for (const match of ['*', `"other", W/${image.headers.etag}`, `  ${image.headers.etag}  `]) {
      const cached = await send(`/api/signs/${entry.code}/image`, {
        headers: { 'If-None-Match': match },
      })
      expect(cached.status).toBe(304)
      expect(cached.headers.etag).toBe(image.headers.etag)
      expect(cached.headers['cache-control']).toBe('private, no-cache')
      expect(cached.body.length).toBe(0)
    }
  })

  const nested = z
    .object({ nested: z.object({ value: z.string() }) })
    .safeParse({ nested: { value: 1 } }).error!
  const root = z.string().safeParse(1).error!
  const cases = [
    [new RevisionConflict(), 409],
    [new RecoveryOwned(), 409],
    [new AmbiguousPu66Key(), 409],
    [new InvalidPu66Verification(), 400],
    [new InvalidPu66Lifecycle('synthetic lifecycle'), 400],
    [new InvalidPu66Upload('synthetic PU-66', 422), 422],
    [new InvalidSignUpload('synthetic signs', 413), 413],
    [new InvalidDocumentUpload('synthetic PDF', 415), 415],
    [new DocumentInUse('synthetic reference'), 409],
    [new ProjectTooLarge(), 413],
    [new ParameterConfirmationConflict(), 409, { reason: 'document-changed', field: 'document' }],
    [
      new InvalidParameter('synthetic parameter', 404, 'no-document', 'document'),
      404,
      { reason: 'no-document', field: 'document' },
    ],
    [nested, 400, {}, 'Неверное поле «nested.value».'],
    [root, 400, {}, 'Неверное поле «запись».'],
  ] as const
  it.each(cases)(
    'maps expected error %# without reporting a server failure',
    async (error, status, details = {}, message: string = error.message) => {
      const { store, diagnostics, send } = await setup()
      vi.spyOn(store, 'listCrossings').mockImplementation(() => {
        throw error
      })
      const failure = vi.spyOn(diagnostics, 'serverError')
      const response = await send('/api/crossings')
      expect(response.status).toBe(status)
      expect(JSON.parse(response.body.toString())).toEqual({ error: message, ...details })
      expect(response.headers['content-type']).toBe('application/json; charset=utf-8')
      expect(response.headers['cache-control']).toBe('no-store')
      expect(response.headers['x-content-type-options']).toBe('nosniff')
      expect(failure).not.toHaveBeenCalled()
    },
  )

  it('hides an unexpected error and reports it once with a sanitized route', async () => {
    const { store, diagnostics, send } = await setup()
    const error = new Error('synthetic private detail')
    vi.spyOn(store, 'listCrossings').mockImplementation(() => {
      throw error
    })
    const failure = vi.spyOn(diagnostics, 'serverError')
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const response = await send('/api/crossings?secret=synthetic')
    expect(response.status).toBe(500)
    expect(JSON.parse(response.body.toString())).toEqual({
      error: 'Внутренняя ошибка локального реестра.',
    })
    expect(failure).toHaveBeenCalledExactlyOnceWith('GET /api/crossings', error)
    expect(consoleError).toHaveBeenCalledExactlyOnceWith('Ошибка локального реестра:', error)
  })
})
