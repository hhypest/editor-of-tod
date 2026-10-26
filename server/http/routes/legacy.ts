import { crossingWriteSchema, normativeWriteSchema } from '../../../src/domain/registry.ts'
import type { LegacyRegistryRepository } from '../../legacy/legacy-registry-repository.ts'
import { json, readJson } from '../json.ts'
import type { RouteHandler } from '../route.ts'

export type LegacyRouteStorage = Pick<
  LegacyRegistryRepository,
  'listCrossings' | 'listNormative' | 'saveCrossing' | 'saveNormative'
>

export function createLegacyRoutes(storage: LegacyRouteStorage): RouteHandler {
  return async (req, res, url) => {
    const pathname = url.pathname
    if (req.method === 'GET' && pathname === '/api/crossings') {
      json(res, 200, storage.listCrossings())
    } else if (req.method === 'GET' && pathname === '/api/normative') {
      json(res, 200, storage.listNormative())
    } else if (req.method === 'PUT' && pathname === '/api/crossings') {
      const { expectedRevision, ...draft } = crossingWriteSchema.parse(await readJson(req))
      json(res, 200, storage.saveCrossing(draft, expectedRevision))
    } else if (req.method === 'PUT' && pathname === '/api/normative') {
      const { expectedRevision, ...draft } = normativeWriteSchema.parse(await readJson(req))
      json(res, 200, storage.saveNormative(draft, expectedRevision))
    } else return false
    return true
  }
}
