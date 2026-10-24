import { z } from 'zod'
import {
  crossingDraftSchema,
  normativeDraftSchema,
  type CrossingDraft,
  type NormativeDraft,
} from '../domain/registry'
import { parseLocalData, requestLocalData } from './local-data'

const revision = { revision: z.number().int().positive(), updatedAt: z.string() }
const crossingRecord = crossingDraftSchema.extend(revision)
const normativeRecord = normativeDraftSchema.safeExtend(revision)

export async function listRegistryCrossings() {
  return parseLocalData(crossingRecord.array(), await requestLocalData('/api/crossings'))
}

export async function listRegistryNormatives() {
  return parseLocalData(normativeRecord.array(), await requestLocalData('/api/normative'))
}

function write(body: unknown): RequestInit {
  return {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }
}

export async function saveRegistryCrossing(draft: CrossingDraft, expectedRevision: number) {
  return parseLocalData(
    crossingRecord,
    await requestLocalData('/api/crossings', write({ ...draft, expectedRevision })),
  )
}

export async function saveRegistryNormative(draft: NormativeDraft, expectedRevision: number) {
  return parseLocalData(
    normativeRecord,
    await requestLocalData('/api/normative', write({ ...draft, expectedRevision })),
  )
}

export async function createRegistryBackup() {
  return parseLocalData(
    z.object({ filename: z.string() }),
    await requestLocalData('/api/backup', { method: 'POST' }),
  )
}
