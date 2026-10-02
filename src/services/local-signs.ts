import { z } from 'zod'
import { localJson } from './json-response'

export const MAX_WEB_SIGN_ARCHIVE_BYTES = 32 * 1024 * 1024
export const MAX_WEB_SIGN_PDF_BYTES = 10 * 1024 * 1024

const counts = {
  added: z.number().int().nonnegative(),
  updated: z.number().int().nonnegative(),
  unchanged: z.number().int().nonnegative(),
  retired: z.number().int().nonnegative(),
  relabelled: z.number().int().nonnegative(),
  addedCodes: z.array(z.string()),
  changedCodes: z.array(z.string()),
  retiredCodes: z.array(z.string()),
}
const sourceSchema = z.strictObject({
  documentCode: z.string(),
  edition: z.string(),
  pdfSha256: z.string().nullable(),
  documentId: z.number().int().positive().nullable().optional(),
})
const catalogSchema = z.strictObject({
  id: z.number().int().positive(),
  documentCode: z.string(),
  edition: z.string(),
  pdfSha256: z.string().nullable(),
  zipSha256: z.string(),
  signCount: z.number().int().nonnegative(),
  importedAt: z.string(),
  documentId: z.number().int().positive().nullable(),
})
const planSchema = z.strictObject({
  ...counts,
  signCount: z.number().int().nonnegative(),
  source: sourceSchema,
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  /** Новые изображения изменённых знаков для сравнения с текущими. */
  changedPreviews: z.array(z.strictObject({ code: z.string(), image: z.string() })),
})
const resultSchema = z.strictObject({
  ...counts,
  signCount: z.number().int().nonnegative(),
  source: sourceSchema,
  backup: z.string().nullable(),
  catalog: catalogSchema.nullable(),
})
export type SignImportPlan = z.infer<typeof planSchema>
export type SignCatalog = z.infer<typeof catalogSchema>

async function base64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  let text = ''
  for (let index = 0; index < bytes.length; index += 8192) {
    text += String.fromCharCode(...bytes.subarray(index, index + 8192))
  }
  return btoa(text)
}

/** Источник архива: документ библиотеки или код и редакция, введённые вручную. */
export type SignSourceInput =
  { documentId: number } | { documentCode: string; edition: string; pdf: File | null }

async function payload(zip: File, source: SignSourceInput) {
  const pdf = 'pdf' in source ? source.pdf : null
  const documentCode = 'documentCode' in source ? source.documentCode : 'из библиотеки'
  const edition = 'edition' in source ? source.edition : 'из библиотеки'
  if (!/\.zip$/i.test(zip.name) || zip.size > MAX_WEB_SIGN_ARCHIVE_BYTES) {
    throw new Error('Выберите ZIP знаков размером не больше 32 МБ.')
  }
  if (pdf && (!/\.pdf$/i.test(pdf.name) || pdf.size > MAX_WEB_SIGN_PDF_BYTES)) {
    throw new Error('PDF источника должен быть размером не больше 10 МБ.')
  }
  if (!documentCode.trim() || !edition.trim()) throw new Error('Укажите документ и редакцию.')
  return {
    archive: { name: zip.name, data: await base64(zip) },
    pdf: pdf ? { name: pdf.name, data: await base64(pdf) } : null,
    documentCode: documentCode.trim(),
    edition: edition.trim(),
    documentId: 'documentId' in source ? source.documentId : null,
  }
}

async function request(path: string, body: unknown) {
  let response: Response
  try {
    response = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch {
    throw new Error('Локальный реестр недоступен. Запустите npm run dev или npm run local.')
  }
  const result = await localJson(response)
  if (!response.ok) {
    throw new Error(
      result && typeof result === 'object' && 'error' in result && typeof result.error === 'string'
        ? result.error
        : `Ошибка локального реестра (${response.status}).`,
    )
  }
  return result
}

export async function previewSignFiles(
  zip: File,
  source: SignSourceInput,
): Promise<SignImportPlan> {
  return planSchema.parse(await request('/api/signs/import/preview', await payload(zip, source)))
}

export async function applySignFiles(zip: File, source: SignSourceInput, fingerprint: string) {
  return resultSchema.parse(
    await request('/api/signs/import/apply', {
      ...(await payload(zip, source)),
      expectedFingerprint: fingerprint,
    }),
  )
}

export async function getSignCatalog(): Promise<SignCatalog | null> {
  const response = await fetch('/api/signs/catalog')
  if (!response.ok) throw new Error('Не удалось прочитать источник каталога.')
  return catalogSchema.nullable().parse(await localJson(response))
}

const pdfImageSchema = z.strictObject({
  key: z.string(),
  page: z.number().int().positive(),
  detected: z.string().nullable(),
  example: z.boolean(),
  code: z.string().nullable(),
  reason: z.enum(['detected', 'override', 'excluded', 'no-label']),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
})
const pdfPlanSchema = z.strictObject({
  ...counts,
  document: z.strictObject({ id: z.number(), code: z.string(), edition: z.string() }),
  pages: z.strictObject({ first: z.number(), last: z.number() }).nullable(),
  yellowRule: z
    .strictObject({ clause: z.string(), text: z.string(), items: z.array(z.string()) })
    .nullable(),
  yellowCodes: z.array(z.string()),
  images: z.array(pdfImageSchema),
  signCount: z.number().int().nonnegative(),
  source: sourceSchema,
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
})
export type PdfSignPlan = z.infer<typeof pdfPlanSchema>
export type PdfSignImage = z.infer<typeof pdfImageSchema>
/** Исправления составителя: номер знака или null — исключить изображение. */
export type PdfSignOverrides = Record<string, string | null>

export async function previewPdfSigns(
  documentId: number,
  overrides: PdfSignOverrides,
): Promise<PdfSignPlan> {
  return pdfPlanSchema.parse(
    await request(`/api/documents/${documentId}/signs/preview`, { overrides }),
  )
}

export async function applyPdfSigns(
  documentId: number,
  overrides: PdfSignOverrides,
  fingerprint: string,
) {
  return resultSchema.parse(
    await request(`/api/documents/${documentId}/signs/apply`, {
      overrides,
      expectedFingerprint: fingerprint,
    }),
  )
}

export function pdfSignImageUrl(documentId: number, key: string, yellow = false): string {
  return `/api/documents/${documentId}/signs/image?key=${encodeURIComponent(key)}${yellow ? '&yellow=1' : ''}`
}

/** Новый адрес обходит годовой immutable-кэш прежних версий; дальше действует ETag. */
export function signImageUrl(code: string, revision?: number): string {
  return `/api/signs/${encodeURIComponent(code)}/image?cache=2${revision ? `&rev=${revision}` : ''}`
}
