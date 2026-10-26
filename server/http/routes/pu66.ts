import type { Pu66Summary, Pu66Scheme, Pu66Norms } from '../../pu66/repository.ts'
import { pu66LifecycleWriteSchema, type Pu66Status } from '../../../src/domain/pu66-lifecycle.ts'
import {
  pu66VerificationWriteSchema,
  type Pu66Verification,
  type Pu66VerificationWrite,
} from '../../../src/domain/pu66-review.ts'
import { applyPu66Lifecycle, type Pu66LifecycleCommands } from '../../pu66-lifecycle.ts'
import {
  applyPu66Upload,
  previewPu66Upload,
  PU66_UPLOAD_REQUEST_BYTES,
  type Pu66ImportCommands,
} from '../../pu66-web-import.ts'
import { InvalidPu66Lifecycle } from '../../pu66/errors.ts'
import { RequestError } from '../request-error.ts'
import { json, readJson } from '../json.ts'
import { decodeKey } from '../path.ts'
import type { RouteHandler } from '../route.ts'

export interface Pu66RouteDependencies {
  cards: {
    list(includeExcluded?: boolean): Pu66Summary[]
    getNorms(key: string): Pu66Norms | null
    getScheme(key: string): Pu66Scheme | null
  }
  lifecycle: {
    getStatus(key: string): Pu66Status | null
    list(key: string): Array<NonNullable<Pu66Status['event']>> | null
  }
  verifications: {
    list(key: string): Pu66Verification[] | null
    record(key: string, input: Pu66VerificationWrite): Pu66Verification | null
  }
  lifecycleCommands: Pu66LifecycleCommands
  importCommands: Pu66ImportCommands
}

export function createPu66Routes({
  cards,
  lifecycle,
  verifications,
  lifecycleCommands,
  importCommands,
}: Pu66RouteDependencies): RouteHandler {
  return async (req, res, url) => {
    const pathname = url.pathname
    if (req.method === 'GET' && pathname === '/api/pu66') {
      json(res, 200, cards.list())
    } else if (req.method === 'GET' && pathname === '/api/pu66/lifecycle') {
      json(
        res,
        200,
        cards.list(true).map((card) => ({
          ...card,
          status: lifecycle.getStatus(card.referenceId),
        })),
      )
    } else if (req.method === 'POST' && pathname === '/api/pu66/lifecycle/preview') {
      json(
        res,
        200,
        lifecycleCommands.planPu66Lifecycle(pu66LifecycleWriteSchema.parse(await readJson(req))),
      )
    } else if (req.method === 'POST' && pathname === '/api/pu66/lifecycle/apply') {
      json(res, 200, await applyPu66Lifecycle(lifecycleCommands, await readJson(req)))
    } else if (req.method === 'GET' && /^\/api\/pu66\/[^/]+\/status$/.test(pathname)) {
      const key = decodeKey(pathname.slice('/api/pu66/'.length, -'/status'.length))
      json(res, 200, lifecycle.getStatus(key))
    } else if (req.method === 'GET' && /^\/api\/pu66\/[^/]+\/lifecycle$/.test(pathname)) {
      const key = decodeKey(pathname.slice('/api/pu66/'.length, -'/lifecycle'.length))
      const history = lifecycle.list(key)
      if (!history) throw new RequestError(404, 'Карточка ПУ-66 не найдена.')
      json(res, 200, history)
    } else if (req.method === 'POST' && pathname === '/api/pu66/import/preview') {
      json(
        res,
        200,
        await previewPu66Upload(importCommands, await readJson(req, PU66_UPLOAD_REQUEST_BYTES)),
      )
    } else if (req.method === 'POST' && pathname === '/api/pu66/import/apply') {
      json(
        res,
        200,
        await applyPu66Upload(importCommands, await readJson(req, PU66_UPLOAD_REQUEST_BYTES)),
      )
    } else if (
      req.method === 'GET' &&
      pathname.startsWith('/api/pu66/') &&
      pathname.endsWith('/norms')
    ) {
      const key = decodeKey(pathname.slice('/api/pu66/'.length, -'/norms'.length))
      const norms = cards.getNorms(key)
      if (!norms) throw new RequestError(404, 'Карточка ПУ-66 не найдена.')
      json(res, 200, norms)
    } else if (
      req.method === 'GET' &&
      pathname.startsWith('/api/pu66/') &&
      pathname.endsWith('/scheme')
    ) {
      const encodedKey = pathname.slice('/api/pu66/'.length, -'/scheme'.length)
      const key = decodeKey(encodedKey)
      if (lifecycle.getStatus(key)?.excluded)
        throw new InvalidPu66Lifecycle('Карточка ПУ-66 исключена. Выберите действующую карточку.')
      const fields = cards.getScheme(key)
      if (!fields) throw new RequestError(404, 'Карточка ПУ-66 не найдена.')
      json(res, 200, fields)
    } else if (
      req.method === 'GET' &&
      pathname.startsWith('/api/pu66/') &&
      pathname.endsWith('/verifications')
    ) {
      const key = decodeKey(pathname.slice('/api/pu66/'.length, -'/verifications'.length))
      const history = verifications.list(key)
      if (!history) throw new RequestError(404, 'Карточка ПУ-66 не найдена.')
      json(res, 200, history)
    } else if (
      req.method === 'POST' &&
      pathname.startsWith('/api/pu66/') &&
      pathname.endsWith('/verification')
    ) {
      const key = decodeKey(pathname.slice('/api/pu66/'.length, -'/verification'.length))
      const input = pu66VerificationWriteSchema.parse(await readJson(req))
      const verification = verifications.record(key, input)
      if (!verification) throw new RequestError(404, 'Карточка ПУ-66 не найдена.')
      json(res, 201, verification)
    } else return false
    return true
  }
}
