import { z } from 'zod'
import { pu66SchemeRecordSchema, type Pu66SchemeRecord } from '../domain/pu66-snapshot'
import {
  pu66VerificationWriteSchema,
  type Pu66Verification,
  type Pu66VerificationWrite,
} from '../domain/pu66-review'
import { localJson } from './json-response'

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

export const MAX_WEB_PU66_FILES = 4
export const MAX_WEB_PU66_FILE_BYTES = 4 * 1024 * 1024

const importPlanSchema = z.strictObject({
  added: z.number().int().nonnegative(),
  updated: z.number().int().nonnegative(),
  unchanged: z.number().int().nonnegative(),
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  items: z.array(
    z.strictObject({
      filename: z.string(),
      referenceId: z.string(),
      location: z.string(),
      roadName: z.string(),
      action: z.enum(['add', 'update', 'unchanged']),
      currentRevision: z.number().int().nonnegative(),
    }),
  ),
})
export type Pu66ImportPlan = z.infer<typeof importPlanSchema>

const importResultSchema = z.strictObject({
  added: z.number().int().nonnegative(),
  updated: z.number().int().nonnegative(),
  unchanged: z.number().int().nonnegative(),
  backup: z.string().nullable(),
})

function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error(`Не удалось прочитать выбранный файл ${file.name}.`))
    reader.onload = () => {
      const value = reader.result
      const comma = typeof value === 'string' ? value.indexOf(',') : -1
      if (typeof value !== 'string' || comma < 0) {
        reject(new Error(`Не удалось прочитать выбранный файл ${file.name}.`))
      } else {
        resolve(value.slice(comma + 1))
      }
    }
    reader.readAsDataURL(file)
  })
}

async function uploadPayload(files: File[]): Promise<Array<{ name: string; data: string }>> {
  if (files.length < 1 || files.length > MAX_WEB_PU66_FILES)
    throw new Error(`Выберите от 1 до ${MAX_WEB_PU66_FILES} файлов ПУ-66.`)
  if (files.some((file) => !/\.xlsx$/i.test(file.name) || file.size > MAX_WEB_PU66_FILE_BYTES)) {
    throw new Error('Выберите книги XLSX размером не больше 4 МБ каждая.')
  }
  return Promise.all(files.map(async (file) => ({ name: file.name, data: await readBase64(file) })))
}

async function request(url: string, options?: RequestInit): Promise<unknown> {
  let response: Response
  try {
    response = await fetch(url, options)
  } catch {
    throw new Error('Локальный реестр недоступен. Запустите npm run dev или npm run local.')
  }
  if (!response.ok) {
    const body = await localJson(response)
    const message =
      typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'string'
        ? body.error
        : `Ошибка локального реестра (${response.status}).`
    throw new Error(message)
  }
  return localJson(response)
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

export async function previewPu66Files(files: File[]): Promise<Pu66ImportPlan> {
  return importPlanSchema.parse(
    await request('/api/pu66/import/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files: await uploadPayload(files) }),
    }),
  )
}

export async function applyPu66Files(files: File[], fingerprint: string) {
  return importResultSchema.parse(
    await request('/api/pu66/import/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files: await uploadPayload(files), expectedFingerprint: fingerprint }),
    }),
  )
}
