import type { Server } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRegistryServer } from '../index'
import { RegistryStore } from '../store'
import { DiagnosticsLog } from '../diagnostics'
import { catalogEntry } from './sign-catalog-fixture'
import { documentFile, documentMeta } from './normative-document-fixture'
import { listenHttp } from './http-request-fixture'

const servers: Server[] = [],
  stores: RegistryStore[] = []
const headers = { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1:5173' }
const data = (response: { body: Buffer }) => JSON.parse(response.body.toString())
afterEach(async () => {
  vi.restoreAllMocks()
  for (const server of servers.splice(0))
    await new Promise<void>((resolve) => server.close(() => resolve()))
  for (const store of stores.splice(0)) store.close()
})
async function setup() {
  const store = new RegistryStore(':memory:')
  stores.push(store)
  const diagnostics = new DiagnosticsLog(null, { version: 'test', mode: 'test' })
  const request = vi.spyOn(diagnostics, 'request')
  const server = createRegistryServer(store, 0, undefined, diagnostics)
  servers.push(server)
  return { store, request, ...(await listenHttp(server)) }
}

/** Run on the original index handler before moving these branches. */
describe('catalog/document/parameter contracts through createRegistryServer', () => {
  it('keeps sign query limits, decode-once and historical metadata/image validation', async () => {
    const { store, send } = await setup()
    const entry = catalogEntry()
    store.importSigns([entry])
    expect(data(await send('/api/signs?query=9.99'))).toEqual([
      { code: entry.code, width: entry.width, height: entry.height, revision: 1 },
    ])
    expect((await send(`/api/signs?query=${'a'.repeat(80)}`)).status).toBe(200)
    expect(data(await send(`/api/signs?query=${'a'.repeat(81)}`))).toEqual({
      error: 'Поиск слишком длинный.',
    })
    expect(data(await send('/api/signs/%39.99/metadata?rev=1'))).toEqual({
      code: entry.code,
      revision: 1,
      width: entry.width,
      height: entry.height,
    })
    for (const [path, status] of [
      ['/api/signs/%ZZ/image', 400],
      ['/api/signs/%2539.99/image', 400],
      ['/api/signs/9.99/metadata', 400],
      ['/api/signs/9.99/metadata?rev=01', 400],
      ['/api/signs/9.99/metadata?rev=9007199254740992', 400],
      ['/api/signs/9.99/metadata?rev=2', 404],
      ['/api/signs/9.99/image?rev=0', 400],
      ['/api/signs/9.99/image?format=svg', 400],
      ['/api/signs/9.99/image', 200],
      ['/api/signs/9.99/image/extra', 404],
    ] as const)
      expect((await send(path)).status).toBe(status)
  })

  it('keeps numeric document paths, method fallback and upload/default body limits', async () => {
    const { store, send } = await setup(),
      file = documentFile()
    const document = store.addDocument(documentMeta(), file.filename, file.pdf, file.sha256)
    expect((await send(`/api/documents/0${document.id}/pdf`)).body).toEqual(file.pdf)
    expect((await send('/api/documents/9007199254740992/pdf')).status).toBe(400)
    expect((await send('/api/documents/%31/pdf')).status).toBe(404)
    for (const [path, method, status] of [
      ['/api/documents/999/pdf', 'GET', 404],
      ['/api/documents/999', 'GET', 405],
      ['/api/documents/1/pdf', 'POST', 405],
      ['/api/documents/999', 'DELETE', 404],
    ] as const)
      expect((await send(path, { method, headers })).status).toBe(status)
    const input = {
      file: { name: file.filename, data: file.pdf.toString('base64') },
      meta: documentMeta(),
    }
    const preview = await send('/api/documents/preview', {
      method: 'POST',
      headers,
      body: JSON.stringify(input) + ' '.repeat(100_000),
    })
    expect(preview.status).toBe(200)
    expect(data(preview).duplicate).toBeTruthy()
    expect(
      (
        await send(`/api/documents/${document.id}`, {
          method: 'PUT',
          headers,
          body: JSON.stringify(documentMeta()) + ' '.repeat(100_000),
        })
      ).status,
    ).toBe(413)
  })

  it('keeps confirmation rejection details and allowlisted diagnostics for the matching request only', async () => {
    const { send, request } = await setup()
    const id = 'project-b34-max-front',
      path = `/api/normative-parameters/${id}/confirm`
    const response = await send(path, { method: 'POST', headers, body: '{}' })
    expect(response.status).toBe(400)
    expect(data(response)).toMatchObject({ reason: 'invalid-value', field: 'value' })
    expect(request).toHaveBeenLastCalledWith(
      'POST /api/normative-parameters/:id/confirm',
      400,
      expect.any(Number),
      { parameterId: id, rejectionReason: 'invalid-value' },
    )
    expect(
      (
        await send('/api/normative-parameters/unknown/confirm', {
          method: 'POST',
          headers,
          body: '{}',
        })
      ).status,
    ).toBe(404)
    await send(path, { method: 'POST', headers, body: '{' })
    expect(request.mock.calls.at(-1)?.[3]).toBeUndefined()
    expect((await send(path, { method: 'GET' })).status).toBe(404)
  })
})
