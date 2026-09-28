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
  type RecoveryRecord,
  type RecoverySummary,
  type RecoveryWrite,
} from '../domain/recovery'
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

export async function getRecoveryDraft(sessionId: string): Promise<RecoveryRecord> {
  return recoveryRecordSchema.parse(await request(`/api/recovery/${encodeURIComponent(sessionId)}`))
}

export async function saveRecoveryDraft(input: RecoveryWrite): Promise<RecoveryRecord> {
  return recoveryRecordSchema.parse(
    await request(`/api/recovery/${encodeURIComponent(input.sessionId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }),
  )
}

export async function deleteRecoveryDraft(
  sessionId: string,
  expectedVersion: number,
): Promise<void> {
  await request(`/api/recovery/${encodeURIComponent(sessionId)}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expectedVersion }),
  })
}
