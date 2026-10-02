import {
  projectRecordSchema,
  projectRevisionSchema,
  projectSummarySchema,
  type ProjectRecord,
  type ProjectRevision,
  type ProjectSummary,
} from '../domain/local-projects'
import type { Scheme } from '../domain/model'
import {
  recoveryRecordSchema,
  recoverySummarySchema,
  type RecoverySummary,
} from '../domain/recovery'
import { recoveryReceiptSchema } from '../application/recovery-contract'
import type { RecoveryRepository } from '../application/recovery-session'
import { localJson } from './json-response'

async function request(url: string, options?: RequestInit): Promise<unknown> {
  let response: Response
  try {
    response = await fetch(url, options)
  } catch {
    throw new Error('Локальная база недоступна. Запустите npm run dev или npm run local.')
  }
  const body = await localJson(response)
  if (!response.ok) {
    const message =
      typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'string'
        ? body.error
        : `Ошибка локальной базы (${response.status}).`
    throw new Error(message)
  }
  return body
}

function url(id: string): string {
  return `/api/projects/${encodeURIComponent(id)}`
}

export async function listLocalProjects(): Promise<ProjectSummary[]> {
  return projectSummarySchema.array().parse(await request('/api/projects'))
}

export async function getLocalProject(id: string): Promise<ProjectRecord> {
  return projectRecordSchema.parse(await request(url(id)))
}

export async function listLocalRevisions(id: string): Promise<ProjectRevision[]> {
  return projectRevisionSchema.array().parse(await request(`${url(id)}/revisions`))
}

export async function getLocalRevision(id: string, revision: number): Promise<ProjectRecord> {
  return projectRecordSchema.parse(await request(`${url(id)}/revisions/${revision}`))
}

export async function saveLocalProject(
  scheme: Scheme,
  expectedRevision: number,
): Promise<ProjectRecord> {
  return projectRecordSchema.parse(
    await request(url(scheme.id), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scheme, expectedRevision }),
    }),
  )
}

export async function restoreLocalRevision(
  id: string,
  sourceRevision: number,
  expectedRevision: number,
): Promise<ProjectRecord> {
  return projectRecordSchema.parse(
    await request(`${url(id)}/restore`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceRevision, expectedRevision }),
    }),
  )
}

export async function listRecoveryDrafts(): Promise<RecoverySummary[]> {
  return recoverySummarySchema.array().parse(await request('/api/recovery'))
}

/** Each editor window gets an independent owner; source references remain local to a copy. */
export function createRecoveryRepository(ownerId: string): RecoveryRepository & {
  releaseOnExit(sessionId: string): void
} {
  const endpoint = (id: string) => `/api/recovery/${encodeURIComponent(id)}`
  const post = (id: string, action: string, fields = {}) =>
    request(`${endpoint(id)}/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ownerId, ...fields }),
    })
  return {
    async save(input, sourceSha256) {
      const scheme =
        sourceSha256 && input.scheme.source.kind === 'legacy-html-v1'
          ? {
              ...input.scheme,
              source: {
                kind: input.scheme.source.kind,
                importedAt: input.scheme.source.importedAt,
              },
            }
          : input.scheme
      return recoveryReceiptSchema.parse(
        await request(endpoint(input.sessionId), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...input, scheme, ownerId, sourceSha256 }),
        }),
      )
    },
    async claim(id, expectedVersion) {
      return recoveryRecordSchema.parse(await post(id, 'claim', { expectedVersion }))
    },
    async remove(id, expectedVersion) {
      await request(endpoint(id), {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ownerId, expectedVersion }),
      })
    },
    async heartbeat(id) {
      await post(id, 'heartbeat')
    },
    async release(id) {
      await post(id, 'release')
    },
    releaseOnExit(id) {
      navigator.sendBeacon(
        `${endpoint(id)}/release`,
        new Blob([JSON.stringify({ ownerId })], { type: 'application/json' }),
      )
    },
  }
}
