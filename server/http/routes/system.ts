import { existsSync } from 'node:fs'
import { json } from '../json.ts'
import type { RouteHandler } from '../route.ts'

const PROBE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export interface SystemRouteDependencies {
  databasePath: string
  databaseId: string
  instanceId: string
  createBackup(): Promise<string>
}

export function createSystemRoutes({
  databasePath,
  databaseId,
  instanceId,
  createBackup,
}: SystemRouteDependencies): RouteHandler {
  return async (req, res, url) => {
    const pathname = url.pathname
    if (req.method === 'GET' && pathname === '/api/status') {
      // Другой запуск программы кладёт рядом со своей базой пустой файл и спрашивает, видим
      // ли мы его рядом с нашей: так он узнаёт, что база та же, каким бы путём её ни открыли.
      const probe = url.searchParams.get('probe')
      const sameFile =
        probe !== null && PROBE_ID.test(probe) && databasePath !== ':memory:'
          ? { probe: existsSync(`${databasePath}.probe-${probe}`) }
          : {}
      json(res, 200, {
        application: 'editor-of-tod',
        ready: true,
        databaseId,
        instanceId,
        ...sameFile,
      })
    } else if (req.method === 'POST' && pathname === '/api/backup') {
      json(res, 201, { filename: await createBackup() })
    } else return false
    return true
  }
}
