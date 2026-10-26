import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  confirmParameter,
  listParameterStates,
  type NormativeParameterStorage,
} from '../../normative-parameters.ts'
import { json, readJson } from '../json.ts'

/** Owned by a single HTTP request, including a failed body read. Never shared between requests. */
export interface ParameterRouteContext {
  parameterId?: string
}

export function createNormativeParameterRoutes(storage: NormativeParameterStorage) {
  return async (
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    context: ParameterRouteContext,
  ): Promise<boolean> => {
    const pathname = url.pathname
    if (req.method === 'GET' && pathname === '/api/normative-parameters') {
      json(res, 200, await listParameterStates(storage))
    } else if (
      req.method === 'POST' &&
      /^\/api\/normative-parameters\/[a-z0-9-]{1,80}\/confirm$/.test(pathname)
    ) {
      const id = pathname.split('/')[3]!
      context.parameterId = id
      json(res, 200, await confirmParameter(storage, id, await readJson(req)))
    } else return false
    return true
  }
}
