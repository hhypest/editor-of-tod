import type { SignCatalogRepository } from '../../signs/catalog-repository.ts'
import type { SignImportCommands } from '../../signs/import-commands.ts'
import {
  applySignUpload,
  previewSignUpload,
  SIGN_UPLOAD_REQUEST_BYTES,
} from '../../sign-web-import.ts'
import { RequestError } from '../request-error.ts'
import { json, readJson } from '../json.ts'
import { decodeKey } from '../path.ts'
import { sendCachedPng } from '../binary.ts'
import type { RouteHandler } from '../route.ts'

export interface SignRouteDependencies {
  catalog: Pick<SignCatalogRepository, 'list' | 'latest' | 'getMetadata' | 'getPng'>
  importCommands: Omit<SignImportCommands, 'getDocumentPdf'>
}

export function createSignRoutes({ catalog, importCommands }: SignRouteDependencies): RouteHandler {
  return async (req, res, url) => {
    const pathname = url.pathname
    if (req.method === 'GET' && pathname === '/api/signs') {
      const query = url.searchParams.get('query') ?? ''
      if (query.length > 80) throw new RequestError(400, 'Поиск слишком длинный.')
      json(res, 200, catalog.list(query, 2_000))
    } else if (req.method === 'GET' && pathname === '/api/signs/catalog') {
      json(res, 200, catalog.latest())
    } else if (req.method === 'POST' && pathname === '/api/signs/import/preview') {
      json(
        res,
        200,
        previewSignUpload(importCommands, await readJson(req, SIGN_UPLOAD_REQUEST_BYTES)),
      )
    } else if (req.method === 'POST' && pathname === '/api/signs/import/apply') {
      json(
        res,
        200,
        await applySignUpload(importCommands, await readJson(req, SIGN_UPLOAD_REQUEST_BYTES)),
      )
    } else if (req.method === 'GET' && /^\/api\/signs\/[^/]+\/metadata$/.test(pathname)) {
      const code = decodeKey(pathname.slice('/api/signs/'.length, -'/metadata'.length))
      if (!/^[0-9][0-9A-Za-z._-]*ж?$/.test(code)) throw new RequestError(400, 'Неверный код знака.')
      const rev = url.searchParams.get('rev')
      if (rev === null || !/^[1-9]\d*$/.test(rev) || !Number.isSafeInteger(Number(rev)))
        throw new RequestError(400, 'Укажите версию изображения знака.')
      const metadata = catalog.getMetadata(code, Number(rev))
      if (!metadata)
        throw new RequestError(404, 'Версия изображения знака не найдена. Обновите каталог.')
      json(res, 200, metadata)
    } else if (req.method === 'GET' && /^\/api\/signs\/[^/]+\/image$/.test(pathname)) {
      const code = decodeKey(pathname.slice('/api/signs/'.length, -'/image'.length))
      if (!/^[0-9][0-9A-Za-z._-]*ж?$/.test(code)) throw new RequestError(400, 'Неверный код знака.')
      const params = url.searchParams
      const format = params.get('format')
      if (format && format !== 'png')
        throw new RequestError(400, 'Изображения знаков доступны только в PNG.')
      const numbered = params.get('numbered') === '1'
      const rev = params.get('rev')
      if (rev !== null && (!/^[1-9]\d*$/.test(rev) || !Number.isSafeInteger(Number(rev))))
        throw new RequestError(400, 'Неверная версия изображения знака.')
      const asset = catalog.getPng(code, numbered, rev === null ? undefined : Number(rev))
      if (!asset) throw new RequestError(404, 'Изображение знака не найдено.')
      sendCachedPng(req, res, asset)
    } else return false
    return true
  }
}
