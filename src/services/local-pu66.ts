import { z } from 'zod'
import { pu66SchemeRecordSchema, type Pu66SchemeRecord } from '../domain/pu66-snapshot'
import {
  pu66VerificationWriteSchema,
  type Pu66Verification,
  type Pu66VerificationWrite,
} from '../domain/pu66-review'

const verificationSchema = z.object({
  cardRevision: z.number().int().positive(),
  verifiedAt: z.iso.date(),
  verifiedBy: z.string(),
  recordedAt: z.iso.datetime(),
})

const pu66ListEntrySchema = z.object({
  referenceId: z.string(),
  location: z.string(),
  roadName: z.string(),
  revision: z.number().int().positive(),
  verification: verificationSchema.nullable(),
})
export type Pu66ListEntry = z.infer<typeof pu66ListEntrySchema>

async function request(url: string, options?: RequestInit): Promise<unknown> {
  let response: Response
  try {
    response = await fetch(url, options)
  } catch {
    throw new Error('Локальный реестр недоступен. Запустите npm run dev или npm run local.')
  }
  if (!response.ok) {
    const body: unknown = await response.json()
    const message =
      typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'string'
        ? body.error
        : `Ошибка локального реестра (${response.status}).`
    throw new Error(message)
  }
  return response.json()
}

export async function listPu66Cards(): Promise<Pu66ListEntry[]> {
  return pu66ListEntrySchema.array().parse(await request('/api/pu66'))
}

export async function getPu66SchemeRecord(key: string): Promise<Pu66SchemeRecord> {
  return pu66SchemeRecordSchema.parse(await request(`/api/pu66/${encodeURIComponent(key)}/scheme`))
}

export async function listPu66Verifications(key: string): Promise<Pu66Verification[]> {
  return z
    .array(verificationSchema)
    .parse(await request(`/api/pu66/${encodeURIComponent(key)}/verifications`))
}

export async function recordPu66Verification(
  key: string,
  input: Pu66VerificationWrite,
): Promise<Pu66Verification> {
  return verificationSchema.parse(
    await request(`/api/pu66/${encodeURIComponent(key)}/verification`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(pu66VerificationWriteSchema.parse(input)),
    }),
  )
}
