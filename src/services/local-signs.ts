import { z } from 'zod'
import { localJson } from './json-response'

export const MAX_WEB_SIGN_ARCHIVE_BYTES = 32 * 1024 * 1024
export const MAX_WEB_SIGN_PDF_BYTES = 10 * 1024 * 1024

const counts = {
  added: z.number().int().nonnegative(),
  updated: z.number().int().nonnegative(),
  unchanged: z.number().int().nonnegative(),
  retired: z.number().int().nonnegative(),
}
const catalogSchema = z.strictObject({
  id: z.number().int().positive(),
  documentCode: z.string(),
  edition: z.string(),
  pdfSha256: z.string().nullable(),
  zipSha256: z.string(),
  signCount: z.number().int().nonnegative(),
  importedAt: z.string(),
})
const planSchema = z.strictObject({
  ...counts,
  signCount: z.number().int().nonnegative(),
  source: z.strictObject({
    documentCode: z.string(),
    edition: z.string(),
    pdfSha256: z.string().nullable(),
  }),
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
})
const resultSchema = z.strictObject({
  ...counts,
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

async function payload(zip: File, pdf: File | null, documentCode: string, edition: string) {
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
  pdf: File | null,
  documentCode: string,
  edition: string,
): Promise<SignImportPlan> {
  return planSchema.parse(
    await request('/api/signs/import/preview', await payload(zip, pdf, documentCode, edition)),
  )
}

export async function applySignFiles(
  zip: File,
  pdf: File | null,
  documentCode: string,
  edition: string,
  fingerprint: string,
) {
  return resultSchema.parse(
    await request('/api/signs/import/apply', {
      ...(await payload(zip, pdf, documentCode, edition)),
      expectedFingerprint: fingerprint,
    }),
  )
}

export async function getSignCatalog(): Promise<SignCatalog | null> {
  const response = await fetch('/api/signs/catalog')
  if (!response.ok) throw new Error('Не удалось прочитать источник каталога.')
  return catalogSchema.nullable().parse(await localJson(response))
}
