import { z } from 'zod'
import {
  documentRecordSchema,
  type DocumentMeta,
  type DocumentRecord,
} from '../domain/normative-documents'
import { localJson } from './json-response'
import {
  documentIdentificationSchema,
  type DocumentIdentification,
} from '../domain/document-identification'

export const MAX_DOCUMENT_BYTES = 40 * 1024 * 1024

const statusSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('current') }),
  z.strictObject({ kind: z.literal('superseded'), by: z.number() }),
  z.strictObject({ kind: z.literal('future'), from: z.string() }),
  z.strictObject({ kind: z.literal('undated') }),
  z.strictObject({ kind: z.literal('amendment'), of: z.number(), inForce: z.boolean() }),
])
const previewSchema = z.strictObject({
  sha256: z.string(),
  sizeBytes: z.number(),
  filename: z.string(),
  duplicate: documentRecordSchema.nullable(),
  effect: z.strictObject({
    status: statusSchema,
    replaces: z.array(z.strictObject({ id: z.number(), code: z.string(), edition: z.string() })),
  }),
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
})
export type DocumentPreview = z.infer<typeof previewSchema>

async function send(path: string, method: string, body?: unknown): Promise<unknown> {
  let response: Response
  try {
    response = await fetch(path, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    throw new Error('Локальный реестр недоступен. Запустите npm run dev или npm run local.')
  }
  const result = await localJson(response)
  if (!response.ok)
    throw new Error(
      result && typeof result === 'object' && 'error' in result && typeof result.error === 'string'
        ? result.error
        : `Ошибка локального реестра (${response.status}).`,
    )
  return result
}

async function base64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  let text = ''
  for (let index = 0; index < bytes.length; index += 8192)
    text += String.fromCharCode(...bytes.subarray(index, index + 8192))
  return btoa(text)
}

async function filePayload(file: File) {
  if (!/\.pdf$/i.test(file.name)) throw new Error('Выберите файл PDF.')
  if (file.size > MAX_DOCUMENT_BYTES) throw new Error('PDF больше 40 МБ.')
  return { file: { name: file.name, data: await base64(file) } }
}

async function payload(file: File, meta: DocumentMeta) {
  return { ...(await filePayload(file)), meta }
}

export async function identifyDocument(file: File): Promise<DocumentIdentification> {
  return documentIdentificationSchema.parse(
    await send('/api/documents/identify', 'POST', await filePayload(file)),
  )
}

export async function listDocuments(): Promise<DocumentRecord[]> {
  return documentRecordSchema.array().parse(await send('/api/documents', 'GET'))
}

export async function previewDocument(file: File, meta: DocumentMeta): Promise<DocumentPreview> {
  return previewSchema.parse(
    await send('/api/documents/preview', 'POST', await payload(file, meta)),
  )
}

export async function applyDocument(
  file: File,
  meta: DocumentMeta,
  expectedFingerprint: string,
): Promise<{ document: DocumentRecord; backup: string }> {
  return z.strictObject({ document: documentRecordSchema, backup: z.string() }).parse(
    await send('/api/documents/apply', 'POST', {
      ...(await payload(file, meta)),
      expectedFingerprint,
    }),
  )
}

export async function updateDocument(id: number, meta: DocumentMeta): Promise<DocumentRecord> {
  return documentRecordSchema.parse(await send(`/api/documents/${id}`, 'PUT', meta))
}

export async function deleteDocument(id: number): Promise<void> {
  await send(`/api/documents/${id}`, 'DELETE')
}

export function documentPdfUrl(id: number): string {
  return `/api/documents/${id}/pdf`
}
