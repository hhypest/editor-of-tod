import { createServer, type Server } from 'node:http'
import type { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { zipSync } from 'fflate'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServerServices } from '../composition-root'
import { createSignRoutes, type SignRouteDependencies } from '../http/routes/signs'
import { createDocumentRoutes, type DocumentRouteDependencies } from '../http/routes/documents'
import {
  createNormativeParameterRoutes,
  type ParameterRouteContext,
} from '../http/routes/normative-parameters'
import { checkRequest } from '../http/security'
import { parameterRejection, writeHttpError, type ParameterRejection } from '../http/error-mapper'
import { json } from '../http/json'
import type { SignImportCommands } from '../signs/import-commands'
import { catalogEntry } from './sign-catalog-fixture'
import { documentFile, documentMeta } from './normative-document-fixture'
import { fictionalSignStandard } from './pdf-fixture'
import { listenHttp } from './http-request-fixture'

const servers: Server[] = [],
  connections: DatabaseSync[] = []
const headers = { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1:5173' }
const data = (response: { body: Buffer }) => JSON.parse(response.body.toString())
afterEach(async () => {
  vi.restoreAllMocks()
  for (const server of servers.splice(0))
    await new Promise<void>((resolve) => server.close(() => resolve()))
  for (const db of connections.splice(0)) db.close()
})
async function setup() {
  const services = createServerServices(':memory:', () => '2030-02-01T12:00:00.000Z')
  connections.push(services.db)
  const backup = vi.fn(async () => 'fictional-backup.sqlite')
  const signImportCommands: SignImportCommands = {
    getDocument: (id) => services.documents.get(id),
    getDocumentPdf: (id) => services.documents.getPdf(id),
    planSigns: (entries, source) => services.signCatalog.plan(entries, source),
    importSigns: (entries, source) => services.signCatalog.import(entries, source),
    latestSignCatalog: () => services.signCatalog.latest(),
    createBackup: backup,
  }
  const signDependencies: SignRouteDependencies = {
    catalog: services.signCatalog,
    importCommands: signImportCommands,
  }
  const documentDependencies: DocumentRouteDependencies = {
    documents: {
      list: () => services.documents.list(),
      getPdf: (id) => services.documents.getPdf(id),
      update: (id, meta) => services.documentService.update(id, meta),
      delete: (id) => services.deleteDocumentCommand.execute(id),
    },
    importCommands: {
      listDocuments: () => services.documents.list(),
      addDocument: (meta, filename, pdf, sha256) =>
        services.documentService.add(meta, filename, pdf, sha256),
      createBackup: backup,
    },
    signImportCommands,
  }
  const parameters = {
    listDocuments: () => services.documents.list(),
    getDocument: (id: number) => services.documents.get(id),
    getDocumentPdf: (id: number) => services.documents.getPdf(id),
    getDocumentText: (id: number) => services.documentText.get(id),
    saveDocumentText: (id: number, pages: readonly string[]) =>
      services.documentText.save(id, pages),
    listParameterConfirmations: () => services.parameterConfirmations.list(),
    addParameterConfirmation: (input: Parameters<typeof services.parameterConfirmations.add>[0]) =>
      services.parameterConfirmations.add(input),
  }
  const signs = createSignRoutes(signDependencies),
    documents = createDocumentRoutes(documentDependencies),
    normative = createNormativeParameterRoutes(parameters),
    diagnostics = { serverError: vi.fn() }
  const fallbacks: Array<{ read: boolean; sent: boolean; context: ParameterRouteContext }> = []
  const rejections: Array<ParameterRejection | undefined> = []
  const server = createServer(async (req, res) => {
    const context: ParameterRouteContext = {}
    try {
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Missing address')
      const url = new URL(req.url!, `http://127.0.0.1:${address.port}`)
      checkRequest(req, address.port)
      if (await signs(req, res, url)) return
      if (await normative(req, res, url, context)) return
      if (await documents(req, res, url)) return
      fallbacks.push({ read: req.readableDidRead, sent: res.headersSent, context })
      json(res, 404, { fallback: true })
    } catch (error) {
      rejections.push(parameterRejection(error, context.parameterId))
      writeHttpError(res, error, 'test route', diagnostics)
    }
  })
  servers.push(server)
  const http = await listenHttp(server)
  return {
    ...services,
    ...http,
    backup,
    diagnostics,
    fallbacks,
    rejections,
    signDependencies,
    documentDependencies,
    parameters,
    post: (path: string, body: unknown, padding = '') =>
      http.send(path, { method: 'POST', headers, body: JSON.stringify(body) + padding }),
  }
}
function archive(code = '9.99', marker = 100) {
  const entry = catalogEntry(code, marker)
  return {
    archive: {
      name: 'fictional.zip',
      data: Buffer.from(
        zipSync({
          [`PNG с номером/${code}.png`]: entry.numberedPng,
          [`PNG без номера/${code}.png`]: entry.plainPng,
        }),
      ).toString('base64'),
    },
    documentCode: 'FICTIONAL SIGNS',
    edition: '2030',
    pdf: null,
  }
}

describe('catalog/document/parameter routes without RegistryStore', () => {
  it('keeps historical PNG/metadata after retirement, numbered images and conditional ETag', async () => {
    const { signCatalog, send } = await setup(),
      first = catalogEntry()
    signCatalog.import([first])
    signCatalog.import([catalogEntry(first.code, 150, 16, 10)])
    signCatalog.import([catalogEntry('9.98')])
    expect(data(await send('/api/signs'))).toEqual([
      { code: '9.98', width: 8, height: 6, revision: 1 },
    ])
    expect((await send(`/api/signs/${first.code}/image`)).status).toBe(404)
    const path = `/api/signs/${first.code}/image?rev=1`,
      image = await send(path)
    expect(image.body).toEqual(first.plainPng)
    expect(image.headers['cache-control']).toBe('private, no-cache')
    expect(image.headers['cross-origin-resource-policy']).toBe('same-origin')
    expect(image.headers['content-security-policy']).toBe("default-src 'none'; sandbox")
    expect((await send(`${path}&numbered=1`)).body).toEqual(first.numberedPng)
    expect(data(await send(`/api/signs/${first.code}/metadata?rev=1`))).toEqual({
      code: first.code,
      revision: 1,
      width: 8,
      height: 6,
    })
    expect(data(await send(`/api/signs/${first.code}/metadata?rev=2`))).toMatchObject({
      revision: 2,
      width: 16,
      height: 10,
    })
    const cached = await send(path, {
      headers: { 'If-None-Match': `"other", W/${image.headers.etag}` },
    })
    expect(cached.status).toBe(304)
    expect(cached.body.length).toBe(0)
    expect(cached.headers.etag).toBe(image.headers.etag)
    expect((await send(`/api/signs/${first.code}/metadata?rev=3`)).status).toBe(404)
    expect(data(await send('/api/signs/catalog'))).toMatchObject({ id: 3, signCount: 1 })
  })

  it('accepts ZIP preview above 64 KiB, applies only a reviewed plan and no-ops without another backup', async () => {
    const { post, backup, signCatalog } = await setup(),
      input = archive()
    const preview = data(await post('/api/signs/import/preview', input, ' '.repeat(100_000)))
    expect(preview).toMatchObject({ added: 1, signCount: 1 })
    expect(signCatalog.latest()).toBeNull()
    expect(
      (await post('/api/signs/import/apply', { ...input, expectedFingerprint: '0'.repeat(64) }))
        .status,
    ).toBe(409)
    expect(backup).not.toHaveBeenCalled()
    expect(
      data(
        await post('/api/signs/import/apply', {
          ...input,
          expectedFingerprint: preview.fingerprint,
        }),
      ),
    ).toMatchObject({ added: 1, backup: 'fictional-backup.sqlite' })
    const unchanged = data(await post('/api/signs/import/preview', input))
    expect(
      data(
        await post('/api/signs/import/apply', {
          ...input,
          expectedFingerprint: unchanged.fingerprint,
        }),
      ),
    ).toMatchObject({ unchanged: 1, backup: null })
    expect(backup).toHaveBeenCalledTimes(1)
  })

  it('rechecks the ZIP source changed during backup before recording any catalog', async () => {
    const { documentService, documents, post, backup, signCatalog, signDependencies } =
        await setup(),
      file = documentFile()
    const document = documentService.add(documentMeta(), file.filename, file.pdf, file.sha256)
    const input = { ...archive(), documentId: document.id },
      preview = data(await post('/api/signs/import/preview', input))
    const record = vi.spyOn(signDependencies.importCommands, 'importSigns')
    backup.mockImplementationOnce(async () => {
      documentService.update(document.id, { ...documentMeta(), edition: '2031' })
      return 'fictional-backup.sqlite'
    })
    expect(
      (
        await post('/api/signs/import/apply', {
          ...input,
          expectedFingerprint: preview.fingerprint,
        })
      ).status,
    ).toBe(409)
    expect(record).not.toHaveBeenCalled()
    expect(signCatalog.latest()).toBeNull()
    expect(documents.get(document.id)?.edition).toBe('2031')
  })

  it('identifies/previews/applies a PDF, preserves bytes and updates/deletes its metadata and text', async () => {
    const { post, send, backup, documents, documentText } = await setup(),
      file = documentFile()
    const input = {
      file: { name: file.filename, data: file.pdf.toString('base64') },
      meta: documentMeta(),
    }
    expect(
      (await post('/api/documents/identify', { file: input.file }, ' '.repeat(100_000))).status,
    ).toBe(200)
    const preview = data(await post('/api/documents/preview', input))
    expect(documents.list()).toEqual([])
    const applied = await post('/api/documents/apply', {
      ...input,
      expectedFingerprint: preview.fingerprint,
    })
    expect(applied.status).toBe(201)
    const { document } = data(applied)
    const pdf = await send(`/api/documents/${document.id}/pdf`)
    expect(pdf.body).toEqual(file.pdf)
    expect(pdf.headers['content-type']).toBe('application/pdf')
    expect(pdf.headers['cache-control']).toBe('no-store')
    const duplicate = data(await post('/api/documents/preview', input))
    expect(
      (await post('/api/documents/apply', { ...input, expectedFingerprint: duplicate.fingerprint }))
        .status,
    ).toBe(409)
    expect(backup).toHaveBeenCalledTimes(1)
    const updated = await send(`/api/documents/${document.id}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ ...input.meta, title: 'Учебное уточнение' }),
    })
    expect(data(updated).title).toBe('Учебное уточнение')
    expect(data(await send('/api/documents'))).toHaveLength(1)
    documentText.save(document.id, ['Fictional cached text'])
    expect(
      data(await send(`/api/documents/${document.id}`, { method: 'DELETE', headers })),
    ).toEqual({ deleted: document.id })
    expect(documentText.get(document.id)).toBeNull()
    expect((await send(`/api/documents/${document.id}/pdf`)).status).toBe(404)
  })

  it('rejects a document plan changed during backup without adding its PDF', async () => {
    const { post, documents, documentService, backup } = await setup(),
      file = documentFile()
    const input = {
      file: { name: file.filename, data: file.pdf.toString('base64') },
      meta: documentMeta(),
    }
    const preview = data(await post('/api/documents/preview', input))
    backup.mockImplementationOnce(async () => {
      const other = documentFile('Another fictional document')
      documentService.add(
        documentMeta({ edition: '2031' }),
        other.filename,
        other.pdf,
        other.sha256,
      )
      return 'fictional-backup.sqlite'
    })
    expect(
      (await post('/api/documents/apply', { ...input, expectedFingerprint: preview.fingerprint }))
        .status,
    ).toBe(409)
    expect(documents.list()).toHaveLength(1)
    expect(documents.findBySha(file.sha256)).toBeNull()
  })

  it('previews PDF signs, serves plain/yellow PNG and applies explicit exclusions without replacing history', async () => {
    const { documentService, post, send, backup, signCatalog } = await setup(),
      pdf = fictionalSignStandard()
    const document = documentService.add(
      documentMeta(),
      'fictional.pdf',
      pdf,
      createHash('sha256').update(pdf).digest('hex'),
    )
    const base = `/api/documents/${document.id}/signs`
    const preview = data(await post(`${base}/preview`, {}))
    const unknown = preview.images.find((item: { reason: string }) => item.reason === 'no-label')
    expect(unknown).toBeDefined()
    expect((await post(`${base}/apply`, { expectedFingerprint: preview.fingerprint })).status).toBe(
      400,
    )
    expect(backup).not.toHaveBeenCalled()
    const overrides = { [unknown.key]: null },
      reviewed = data(await post(`${base}/preview`, { overrides }))
    const key = reviewed.images.find((item: { code: string }) => item.code === '1.8').key
    const plain = await send(`${base}/image?key=${key}`),
      yellow = await send(`${base}/image?key=${key}&yellow=1`)
    expect(plain.status).toBe(200)
    expect(yellow.status).toBe(200)
    expect(yellow.body).not.toEqual(plain.body)
    expect(yellow.headers['content-type']).toBe('image/png')
    expect(yellow.headers['cache-control']).toBe('no-store')
    expect((await send(`${base}/image?key=bad`)).status).toBe(400)
    expect((await post(`${base}/preview`, {}, ' '.repeat(100_000))).status).toBe(413)
    expect(
      (await post(`${base}/apply`, { overrides, expectedFingerprint: reviewed.fingerprint }))
        .status,
    ).toBe(200)
    expect(Buffer.from(signCatalog.getPng('1.8', false, 1)!)).toEqual(plain.body)
    const unchanged = data(await post(`${base}/preview`, { overrides }))
    expect(
      data(await post(`${base}/apply`, { overrides, expectedFingerprint: unchanged.fingerprint }))
        .backup,
    ).toBeNull()
    expect(backup).toHaveBeenCalledTimes(1)
    expect(
      (await send(`/api/documents/${document.id}`, { method: 'DELETE', headers })).status,
    ).toBe(409)
    expect(
      (
        await send(`/api/documents/${document.id}`, {
          method: 'PUT',
          headers,
          body: JSON.stringify(documentMeta({ kind: 'other' })),
        })
      ).status,
    ).toBe(409)
  })

  it('keeps document/text deletion atomic on failure and refuses amendment references', async () => {
    const { documentService, documents, documentText, db, send, diagnostics } = await setup(),
      file = documentFile()
    const document = documentService.add(documentMeta(), file.filename, file.pdf, file.sha256)
    documentText.save(document.id, ['Fictional cached text'])
    db.exec(
      `CREATE TRIGGER reject_document_delete BEFORE DELETE ON normative_documents BEGIN SELECT RAISE(ABORT, 'synthetic deletion failure'); END`,
    )
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    expect(
      (await send(`/api/documents/${document.id}`, { method: 'DELETE', headers })).status,
    ).toBe(500)
    expect(Buffer.from(documents.getPdf(document.id)!.pdf)).toEqual(file.pdf)
    expect(documentText.get(document.id)).toEqual(['Fictional cached text'])
    expect(diagnostics.serverError).toHaveBeenCalledTimes(1)
    db.exec('DROP TRIGGER reject_document_delete')
    const amendment = documentFile('Fictional amendment')
    documentService.add(
      documentMeta({ amendsId: document.id }),
      amendment.filename,
      amendment.pdf,
      amendment.sha256,
    )
    expect(
      (await send(`/api/documents/${document.id}`, { method: 'DELETE', headers })).status,
    ).toBe(409)
    expect(documentText.get(document.id)).toEqual(['Fictional cached text'])
  })

  it('confirms decisions and document evidence, preserves conflict details and request-local rejection context', async () => {
    const { post, send, documentService, documentText, parameterConfirmations, rejections } =
      await setup()
    const input = {
      value: 31,
      confirmedBy: 'Учебный специалист',
      note: 'Учебное основание',
      expectedDocumentId: null,
    }
    expect(
      (await post('/api/normative-parameters/project-b34-max-front/confirm', input)).status,
    ).toBe(200)
    const file = documentFile(),
      document = documentService.add(
        documentMeta({
          code: 'ОДМ 218.6.019-2016',
          kind: 'methodology',
          effectiveFrom: '2020-01-01',
        }),
        file.filename,
        file.pdf,
        file.sha256,
      )
    documentText.save(document.id, ['6.4.4 Учебное правило для проверки маршрута.'])
    const path = '/api/normative-parameters/odm-signs-length/confirm'
    const confirmed = await post(path, { ...input, value: 44, expectedDocumentId: document.id })
    expect(confirmed.status).toBe(200)
    expect(data(confirmed)).toMatchObject({ documentId: document.id, page: 1, clause: 'п. 6.4.4' })
    const conflict = await post(path, { ...input, value: 44 })
    expect(conflict.status).toBe(409)
    expect(data(conflict)).toMatchObject({ reason: 'document-changed', field: 'document' })
    expect(rejections.at(-1)).toEqual({
      parameterId: 'odm-signs-length',
      rejectionReason: 'document-changed',
    })
    expect(parameterConfirmations.list()).toHaveLength(2)
    const states = data(await send('/api/normative-parameters'))
    expect(
      states.find((state: { id: string }) => state.id === 'project-b34-max-front').status.kind,
    ).toBe('confirmed')
    const results = await Promise.all(
      ['project-front-limit', 'project-b34-max-front'].map((id) =>
        post(`/api/normative-parameters/${id}/confirm`, {}),
      ),
    )
    expect(results.every((result) => result.status === 400)).toBe(true)
    expect(rejections.slice(-2)).toEqual(
      expect.arrayContaining([
        { parameterId: 'project-front-limit', rejectionReason: 'invalid-value' },
        { parameterId: 'project-b34-max-front', rejectionReason: 'invalid-value' },
      ]),
    )
    expect(
      (await send(`/api/documents/${document.id}`, { method: 'DELETE', headers })).status,
    ).toBe(409)
  })

  it('leaves unmatched requests and their context untouched without invoking any operation', async () => {
    const { send, fallbacks, signDependencies, documentDependencies, parameters } = await setup()
    // Class methods are on the prototype; spy on the supplied query/command surfaces explicitly.
    const spies = [
      vi.spyOn(signDependencies.catalog, 'list'),
      vi.spyOn(signDependencies.catalog, 'latest'),
      vi.spyOn(signDependencies.catalog, 'getPng'),
      vi.spyOn(signDependencies.catalog, 'getMetadata'),
      ...Object.keys(signDependencies.importCommands).map((key) =>
        vi.spyOn(
          signDependencies.importCommands,
          key as keyof typeof signDependencies.importCommands,
        ),
      ),
      ...Object.keys(documentDependencies.documents).map((key) =>
        vi.spyOn(
          documentDependencies.documents,
          key as keyof typeof documentDependencies.documents,
        ),
      ),
      ...Object.keys(documentDependencies.importCommands).map((key) =>
        vi.spyOn(
          documentDependencies.importCommands,
          key as keyof typeof documentDependencies.importCommands,
        ),
      ),
      ...Object.keys(parameters).map((key) => vi.spyOn(parameters, key as keyof typeof parameters)),
    ]
    for (const [path, method] of [
      ['/api/signs', 'POST'],
      ['/api/signs/9.99/image/extra', 'GET'],
      ['/api/documents', 'PUT'],
      ['/api/documents/%31/pdf', 'GET'],
      ['/api/normative-parameters/BAD/confirm', 'POST'],
      ['/api/normative-parameters/project-front-limit/confirm', 'GET'],
    ] as const)
      expect(
        (await send(path, { method, headers: { ...headers, 'Content-Length': '1' }, body: '{' }))
          .status,
      ).toBe(404)
    expect(fallbacks).toHaveLength(6)
    expect(
      fallbacks.every(
        (state) => !state.read && !state.sent && Object.keys(state.context).length === 0,
      ),
    ).toBe(true)
    for (const spy of spies) expect(spy).not.toHaveBeenCalled()
  })
})
