import { afterEach, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import { RegistryStore } from '../store'
import { createRegistryServer } from '../index'
import { identifyDocumentUpload } from '../document-web-import'
import { buildPdf, textPdf } from './pdf-fixture'

const servers: Server[] = []
const stores: RegistryStore[] = []
afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  )
  for (const store of stores.splice(0)) store.close()
})
const upload = (pdf: Buffer, name = 'copy.pdf') => ({
  file: { name, data: pdf.toString('base64') },
})

describe('read-only PDF identification', () => {
  it('reads a real text layer, finds a title after the cover, and limits page extraction', async () => {
    const pdf = textPdf([
      ['Учебная обложка'],
      ['ОДМ 900.1.001-2030', 'Вымышленная методика'],
      ...Array.from({ length: 8 }, () => ['Учебные пояснения']),
    ])
    expect(await identifyDocumentUpload(upload(pdf))).toMatchObject({
      status: 'identified',
      pagesRead: 8,
      candidates: [{ code: 'ОДМ 900.1.001', edition: '2030', kind: 'methodology', page: 2 }],
    })
    expect(await identifyDocumentUpload(upload(buildPdf([[]])))).toMatchObject({
      status: 'no-text',
    })
  })

  it('validates the upload and does not write a library document through the API', async () => {
    const store = new RegistryStore(':memory:')
    stores.push(store)
    const server = createRegistryServer(store, 0)
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing address')
    const post = (body: unknown) =>
      fetch(`http://127.0.0.1:${address.port}/api/documents/identify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1:5173' },
        body: JSON.stringify(body),
      })
    const response = await post(upload(textPdf([['ГОСТ Р 90001-2030', 'Учебный стандарт']])))
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      status: 'identified',
      candidates: [{ code: 'ГОСТ Р 90001' }],
    })
    expect(store.listDocuments()).toEqual([])
    expect((await post(upload(Buffer.from('not a PDF')))).status).toBe(400)
    expect((await post(upload(textPdf([['Учебный текст']]), 'wrong.txt'))).status).toBe(400)
    expect((await post(upload(Buffer.from('%PDF-malformed')))).status).toBe(400)
  })
})
