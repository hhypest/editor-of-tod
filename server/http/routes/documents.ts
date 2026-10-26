import {
  documentMetaSchema,
  type DocumentMeta,
  type DocumentRecord,
} from '../../../src/domain/normative-documents.ts'
import {
  applyDocumentUpload,
  DOCUMENT_UPLOAD_REQUEST_BYTES,
  identifyDocumentUpload,
  previewDocumentUpload,
  type DocumentImportCommands,
} from '../../document-web-import.ts'
import { applyPdfSigns, pdfSignImage, previewPdfSigns } from '../../sign-pdf-import.ts'
import type { SignImportCommands } from '../../signs/import-commands.ts'
import { RequestError } from '../request-error.ts'
import { json, readJson } from '../json.ts'
import { sendPdf, sendPng } from '../binary.ts'
import type { RouteHandler } from '../route.ts'

export interface DocumentRouteDependencies {
  documents: {
    list(): DocumentRecord[]
    getPdf(id: number): { filename: string; pdf: Uint8Array } | null
    update(id: number, meta: DocumentMeta): DocumentRecord | null
    delete(id: number): boolean
  }
  importCommands: DocumentImportCommands
  signImportCommands: SignImportCommands
}

export function createDocumentRoutes({
  documents,
  importCommands,
  signImportCommands,
}: DocumentRouteDependencies): RouteHandler {
  return async (req, res, url) => {
    const pathname = url.pathname
    const documentPath =
      /^\/api\/documents\/(\d+)(\/pdf|\/signs\/preview|\/signs\/apply|\/signs\/image)?$/.exec(
        pathname,
      )
    if (req.method === 'GET' && pathname === '/api/documents') {
      json(res, 200, documents.list())
    } else if (req.method === 'POST' && pathname === '/api/documents/identify') {
      json(
        res,
        200,
        await identifyDocumentUpload(await readJson(req, DOCUMENT_UPLOAD_REQUEST_BYTES)),
      )
    } else if (req.method === 'POST' && pathname === '/api/documents/preview') {
      json(
        res,
        200,
        previewDocumentUpload(importCommands, await readJson(req, DOCUMENT_UPLOAD_REQUEST_BYTES)),
      )
    } else if (req.method === 'POST' && pathname === '/api/documents/apply') {
      json(
        res,
        201,
        await applyDocumentUpload(
          importCommands,
          await readJson(req, DOCUMENT_UPLOAD_REQUEST_BYTES),
        ),
      )
    } else if (documentPath) {
      const id = Number(documentPath[1])
      if (!Number.isSafeInteger(id)) throw new RequestError(400, 'Неверный номер документа.')
      if (req.method === 'GET' && documentPath[2] === '/pdf') {
        const file = documents.getPdf(id)
        if (!file) throw new RequestError(404, 'Документ не найден.')
        sendPdf(res, file)
      } else if (req.method === 'POST' && documentPath[2] === '/signs/preview') {
        json(res, 200, await previewPdfSigns(signImportCommands, id, await readJson(req)))
      } else if (req.method === 'POST' && documentPath[2] === '/signs/apply') {
        json(res, 200, await applyPdfSigns(signImportCommands, id, await readJson(req)))
      } else if (req.method === 'GET' && documentPath[2] === '/signs/image') {
        const params = url.searchParams
        const key = params.get('key') ?? ''
        if (!/^\d{1,4}-\d{1,4}(\.\d{1,2})?$/.test(key))
          throw new RequestError(400, 'Неверный номер изображения.')
        const png = await pdfSignImage(signImportCommands, id, key, params.get('yellow') === '1')
        sendPng(res, png)
      } else if (req.method === 'PUT' && !documentPath[2]) {
        const updated = documents.update(id, documentMetaSchema.parse(await readJson(req)))
        if (!updated) throw new RequestError(404, 'Документ не найден.')
        json(res, 200, updated)
      } else if (req.method === 'DELETE' && !documentPath[2]) {
        if (!documents.delete(id)) throw new RequestError(404, 'Документ не найден.')
        json(res, 200, { deleted: id })
      } else throw new RequestError(405, 'Метод не поддерживается.')
    } else return false
    return true
  }
}
