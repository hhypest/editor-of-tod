import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RequestError } from '../http/request-error'
import { readJson, json } from '../http/json'
import { checkRequest } from '../http/security'
import { decodeKey, projectId } from '../http/path'
import { directoryFiles, defaultStaticFiles, serveBuiltApp } from '../http/static-files'
import { sendPng, sendCachedPng } from '../http/binary'
import { parameterRejection, writeHttpError } from '../http/error-mapper'
import { InvalidParameter, ParameterConfirmationConflict } from '../normative-parameters'
import { listenHttp } from './http-request-fixture'

const servers: Server[] = [],
  directories: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const server of servers.splice(0))
    await new Promise<void>((resolve) => server.close(() => resolve()))
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})
const body = (
  chunks: Iterable<Uint8Array | string> | AsyncIterable<Uint8Array | string>,
  type = 'application/json',
) => Object.assign(Readable.from(chunks), { headers: { 'content-type': type } }) as IncomingMessage
async function transport(
  handle: (req: IncomingMessage, res: ServerResponse, port: number) => void | Promise<void>,
) {
  const diagnostics = { serverError: vi.fn() }
  const server = createServer(async (req, res) => {
    try {
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Missing address')
      await handle(req, res, address.port)
    } catch (error) {
      writeHttpError(res, error, 'test route', diagnostics)
    }
  })
  servers.push(server)
  return { diagnostics, ...(await listenHttp(server)) }
}

describe('HTTP primitives without RegistryStore', () => {
  it('joins split UTF-8 bytes and enforces caller-supplied limits by bytes rather than characters', async () => {
    const text = JSON.stringify({ text: 'ж🚂' }),
      bytes = Buffer.from(text)
    const chunks = [bytes.subarray(0, 10), bytes.subarray(10, 12), bytes.subarray(12)]
    expect(bytes.length).toBeGreaterThan(text.length)
    expect(await readJson(body(chunks), bytes.length)).toEqual({ text: 'ж🚂' })
    await expect(readJson(body(chunks), bytes.length - 1)).rejects.toMatchObject({ status: 413 })
    expect(await readJson(body(['{"value":', '1}']))).toEqual({ value: 1 })
  })

  it('checks media type before consuming a stream and preserves transport failures', async () => {
    const failure = new Error('synthetic stream failure')
    const consumed = vi.fn()
    async function* chunks() {
      consumed()
      yield '{'
      throw failure
    }
    await expect(readJson(body(chunks(), 'text/plain'))).rejects.toMatchObject({ status: 415 })
    expect(consumed).not.toHaveBeenCalled()
    await expect(readJson(body(chunks()))).rejects.toBe(failure)
  })

  it('decodes keys once and keeps the UUID guard and request error identity', () => {
    expect(decodeKey('9%2E99%20%D0%B6')).toBe('9.99 ж')
    expect(decodeKey('%252F')).toBe('%2F')
    const id = '00000000-0000-4000-8000-000000000000'
    expect(projectId(id)).toBe(id)
    expect(() => projectId('%E0%A4%A')).toThrow(RequestError)
    expect(() => projectId('synthetic')).toThrow('Неверный ID проекта.')
  })

  it('assembles security, body reading, JSON and error responses on a plain Node server', async () => {
    const payload = '{"value":1}',
      limit = Buffer.byteLength(payload)
    const { send, port, diagnostics } = await transport(async (req, res, actualPort) => {
      checkRequest(req, actualPort)
      json(res, 201, await readJson(req, limit))
    })
    const headers = { Origin: `http://127.0.0.1:${port}`, 'Content-Type': 'application/json' }
    const response = await send('/', { method: 'POST', headers, body: payload })
    expect(response.status).toBe(201)
    expect(response.body.toString()).toBe(payload)
    expect(response.headers['cache-control']).toBe('no-store')
    expect((await send('/', { method: 'POST', headers, body: payload + ' ' })).status).toBe(413)
    expect(
      (await send('/', { method: 'POST', headers: { ...headers, Origin: 'null' }, body: payload }))
        .status,
    ).toBe(403)
    expect(diagnostics.serverError).not.toHaveBeenCalled()
  })

  it('serves actual directory bytes and keeps the default dist location after moving the module', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'tod-http-static-'))
    directories.push(directory)
    mkdirSync(join(directory, 'assets'))
    const bytes = Buffer.from('/* fictional stylesheet */')
    writeFileSync(join(directory, 'assets', 'test.css'), bytes)
    const files = directoryFiles(directory)
    const { send } = await transport(async (req, res) => serveBuiltApp(req.url!, res, files))
    const response = await send('/assets/test.css')
    expect(response.status).toBe(200)
    expect(response.body).toEqual(bytes)
    expect(response.headers['content-type']).toBe('text/css; charset=utf-8')
    expect((await send('/assets/absent.css')).status).toBe(404)
    await expect(
      defaultStaticFiles()('assets/__fictional_missing_file__.js'),
    ).rejects.toMatchObject({
      code: 'ENOENT',
      path: join(process.cwd(), 'dist', 'assets', '__fictional_missing_file__.js'),
    })
  })

  it('sends preview PNG without caching and revalidates cached bytes without storage', async () => {
    const png = Buffer.from('fictional image bytes')
    const { send } = await transport((req, res) => {
      if (req.url === '/preview') sendPng(res, png)
      else sendCachedPng(req, res, png)
    })
    const preview = await send('/preview')
    expect(preview.body).toEqual(png)
    expect(preview.headers['cache-control']).toBe('no-store')
    expect(preview.headers.etag).toBeUndefined()
    expect(preview.headers['content-security-policy']).toBe("default-src 'none'; sandbox")
    const cached = await send('/cached')
    expect(cached.headers.etag).toMatch(/^"[a-f0-9]{64}"$/)
    expect(
      (await send('/cached', { headers: { 'If-None-Match': `W/${cached.headers.etag}` } })).status,
    ).toBe(304)
    expect((await send('/cached', { headers: { 'If-None-Match': '"different"' } })).body).toEqual(
      png,
    )
  })

  it('retains confirmation conflict details before the broader revision-conflict mapping', async () => {
    const error = new ParameterConfirmationConflict()
    expect(parameterRejection(error, 'synthetic-parameter')).toEqual({
      parameterId: 'synthetic-parameter',
      rejectionReason: 'document-changed',
    })
    expect(parameterRejection(new InvalidParameter('synthetic'), undefined)).toBeUndefined()
    expect(
      parameterRejection(new RequestError(400, 'synthetic'), 'synthetic-parameter'),
    ).toBeUndefined()
    const { send, diagnostics } = await transport(() => {
      throw error
    })
    const response = await send('/')
    expect(response.status).toBe(409)
    expect(JSON.parse(response.body.toString())).toEqual({
      error: error.message,
      reason: 'document-changed',
      field: 'document',
    })
    expect(diagnostics.serverError).not.toHaveBeenCalled()
  })

  it('maps a non-Error failure to a generic response and reports the original value once', async () => {
    const error = { syntheticPrivateValue: 'must not reach response' }
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { send, diagnostics } = await transport(() => {
      throw error
    })
    const response = await send('/')
    expect(response.status).toBe(500)
    expect(JSON.parse(response.body.toString())).toEqual({
      error: 'Внутренняя ошибка локального реестра.',
    })
    expect(diagnostics.serverError).toHaveBeenCalledExactlyOnceWith('test route', error)
    expect(consoleError).toHaveBeenCalledExactlyOnceWith('Ошибка локального реестра:', error)
  })
})
