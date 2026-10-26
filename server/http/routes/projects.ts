import type { Scheme } from '../../../src/domain/model.ts'
import {
  MAX_LOCAL_PROJECT_BYTES,
  projectRestoreSchema,
  projectWriteSchema,
  type ProjectRecord,
  type ProjectRevision,
  type ProjectSummary,
} from '../../../src/domain/local-projects.ts'
import { RequestError } from '../request-error.ts'
import { json, readJson } from '../json.ts'
import { projectId } from '../path.ts'
import type { RouteHandler } from '../route.ts'

export interface ProjectRouteStorage {
  list(): ProjectSummary[]
  get(id: string): ProjectRecord | null
  listRevisions(id: string): ProjectRevision[]
  getRevision(id: string, revision: number): ProjectRecord | null
  save(scheme: Scheme, expectedRevision: number): ProjectRecord
  restore(id: string, sourceRevision: number, expectedRevision: number): ProjectRecord | null
}

export function createProjectRoutes(projects: ProjectRouteStorage): RouteHandler {
  return async (req, res, url) => {
    const pathname = url.pathname
    const projectPath = /^\/api\/projects\/([^/]+)$/.exec(pathname)
    const revisionListPath = /^\/api\/projects\/([^/]+)\/revisions$/.exec(pathname)
    const revisionPath = /^\/api\/projects\/([^/]+)\/revisions\/(\d+)$/.exec(pathname)
    const restorePath = /^\/api\/projects\/([^/]+)\/restore$/.exec(pathname)
    if (req.method === 'GET' && pathname === '/api/projects') {
      json(res, 200, projects.list())
    } else if (req.method === 'GET' && revisionPath) {
      const record = projects.getRevision(projectId(revisionPath[1]!), Number(revisionPath[2]))
      if (!record)
        throw new RequestError(
          404,
          'Версия проекта не найдена. Обновите список проектов и повторите действие.',
        )
      json(res, 200, record)
    } else if (req.method === 'GET' && revisionListPath) {
      const id = projectId(revisionListPath[1]!)
      if (!projects.get(id)) throw new RequestError(404, 'Проект не найден.')
      json(res, 200, projects.listRevisions(id))
    } else if (req.method === 'GET' && projectPath) {
      const record = projects.get(projectId(projectPath[1]!))
      if (!record) throw new RequestError(404, 'Проект не найден.')
      json(res, 200, record)
    } else if (req.method === 'PUT' && projectPath) {
      const id = projectId(projectPath[1]!)
      const { expectedRevision, scheme } = projectWriteSchema.parse(
        await readJson(req, MAX_LOCAL_PROJECT_BYTES + 64 * 1024),
      )
      if (scheme.id !== id) throw new RequestError(400, 'ID проекта в адресе и файле не совпадают.')
      json(res, 200, projects.save(scheme, expectedRevision))
    } else if (req.method === 'POST' && restorePath) {
      const id = projectId(restorePath[1]!)
      const { sourceRevision, expectedRevision } = projectRestoreSchema.parse(await readJson(req))
      const restored = projects.restore(id, sourceRevision, expectedRevision)
      if (!restored)
        throw new RequestError(
          404,
          'Версия проекта не найдена. Обновите список проектов и повторите действие.',
        )
      json(res, 200, restored)
    } else return false
    return true
  }
}
