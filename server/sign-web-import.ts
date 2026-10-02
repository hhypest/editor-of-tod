import { createHash } from 'node:crypto'
import { z } from 'zod'
import { parseSignArchive } from './signs.ts'
import { RegistryStore, RevisionConflict, type SignCatalogSource } from './store.ts'
import { normalizeDocumentCode } from '../src/domain/normative-documents.ts'

const MAX_ZIP_BYTES = 32 * 1024 * 1024
const MAX_PDF_BYTES = 10 * 1024 * 1024
const MAX_CHANGED_PREVIEWS = 120
export const SIGN_UPLOAD_REQUEST_BYTES = 60 * 1024 * 1024

const requestSchema = z.strictObject({
  archive: z.strictObject({
    name: z
      .string()
      .min(1)
      .max(240)
      .regex(/\.zip$/i),
    data: z.string().min(1),
  }),
  documentCode: z.string().trim().min(3).max(120),
  edition: z.string().trim().min(1).max(120),
  /** Документ локальной библиотеки: код, редакция и хеш PDF берутся из него. */
  documentId: z.number().int().positive().nullable().optional(),
  pdf: z
    .strictObject({
      name: z
        .string()
        .min(1)
        .max(240)
        .regex(/\.pdf$/i),
      data: z.string().min(1),
    })
    .nullable(),
})
const applySchema = requestSchema.extend({
  expectedFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
})

export class InvalidSignUpload extends Error {
  readonly status: number
  constructor(message: string, status = 400) {
    super(message)
    this.status = status
  }
}

function decode(data: string, maxBytes: number, label: string): Buffer {
  if (data.length > Math.ceil(maxBytes / 3) * 4) {
    throw new InvalidSignUpload(`${label}: файл слишком велик.`, 413)
  }
  const bytes = Buffer.from(data, 'base64')
  if (bytes.length > maxBytes) throw new InvalidSignUpload(`${label}: файл слишком велик.`, 413)
  if (bytes.toString('base64') !== data)
    throw new InvalidSignUpload(`${label}: неверные данные файла.`)
  return bytes
}

function parse(store: RegistryStore, body: z.infer<typeof requestSchema>) {
  const archive = decode(body.archive.data, MAX_ZIP_BYTES, 'Архив знаков')
  const pdf = body.pdf ? decode(body.pdf.data, MAX_PDF_BYTES, 'PDF ГОСТ') : null
  if (pdf && !pdf.subarray(0, 5).equals(Buffer.from('%PDF-'))) {
    throw new InvalidSignUpload('Выбранный источник не является PDF.')
  }
  let entries: ReturnType<typeof parseSignArchive>
  try {
    entries = parseSignArchive(archive)
  } catch (cause) {
    throw new InvalidSignUpload(
      cause instanceof Error ? cause.message : 'Не удалось прочитать архив знаков.',
    )
  }
  return { entries, source: sourceFor(store, body, pdf) }
}

function sourceFor(
  store: RegistryStore,
  body: z.infer<typeof requestSchema>,
  pdf: Buffer | null,
): SignCatalogSource {
  if (body.documentId) {
    const document = store.getDocument(body.documentId)
    if (!document) throw new InvalidSignUpload('Выбранный документ не найден в библиотеке.')
    if (document.kind !== 'signs')
      throw new InvalidSignUpload('Для ZIP знаков выберите документ вида «Изображения знаков».')
    if (document.amendsId !== null)
      throw new InvalidSignUpload('Выберите основной документ, а не изменение к нему.')
    return {
      documentCode: normalizeDocumentCode(document.code),
      edition: document.edition,
      pdfSha256: document.sha256,
      documentId: document.id,
    }
  }
  return {
    documentCode: body.documentCode,
    edition: body.edition,
    pdfSha256: pdf ? createHash('sha256').update(pdf).digest('hex') : null,
    documentId: null,
  }
}

function plan(store: RegistryStore, parsed: ReturnType<typeof parse>) {
  const counts = store.planSigns(parsed.entries, parsed.source)
  const catalog = store.latestSignCatalog()
  const fingerprint = createHash('sha256')
    .update(
      JSON.stringify({
        source: parsed.source,
        document: parsed.source.documentId ? store.getDocument(parsed.source.documentId) : null,
        archive: parsed.entries[0]?.zipSha256,
        codes: parsed.entries.map((entry) => [entry.code, entry.numberedSha256, entry.plainSha256]),
        counts,
        currentBatchId: catalog?.id ?? null,
      }),
    )
    .digest('hex')
  // Новые изображения изменённых знаков для сравнения со старыми в предварительном просмотре.
  const changed = new Set(counts.changedCodes.slice(0, MAX_CHANGED_PREVIEWS))
  const changedPreviews = parsed.entries
    .filter((entry) => changed.has(entry.code))
    .map((entry) => ({
      code: entry.code,
      image: `data:image/png;base64,${Buffer.from(entry.plainPng).toString('base64')}`,
    }))
  return {
    ...counts,
    fingerprint,
    signCount: parsed.entries.length,
    source: parsed.source,
    changedPreviews,
  }
}

/** Итог записи: те же сведения, что в просмотре, без изображений и отпечатка плана. */
function withoutPreview(preview: ReturnType<typeof plan>) {
  return {
    added: preview.added,
    updated: preview.updated,
    unchanged: preview.unchanged,
    retired: preview.retired,
    relabelled: preview.relabelled,
    addedCodes: preview.addedCodes,
    changedCodes: preview.changedCodes,
    retiredCodes: preview.retiredCodes,
    signCount: preview.signCount,
    source: preview.source,
  }
}

export function previewSignUpload(store: RegistryStore, body: unknown) {
  const parsed = parse(store, requestSchema.parse(body))
  return plan(store, parsed)
}

export async function applySignUpload(store: RegistryStore, body: unknown) {
  const { expectedFingerprint, ...request } = applySchema.parse(body)
  const parsed = parse(store, request)
  const preview = plan(store, parsed)
  if (preview.fingerprint !== expectedFingerprint) throw new RevisionConflict()
  if (preview.added + preview.updated + preview.retired === 0) {
    return { ...withoutPreview(preview), backup: null, catalog: store.latestSignCatalog() }
  }
  const backup = await store.createBackup()
  // Повторная проверка документа после асинхронной резервной копии, до синхронной записи.
  try {
    parsed.source = sourceFor(
      store,
      request,
      request.pdf ? decode(request.pdf.data, MAX_PDF_BYTES, 'PDF ГОСТ') : null,
    )
  } catch (cause) {
    if (cause instanceof InvalidSignUpload) throw new RevisionConflict()
    throw cause
  }
  if (plan(store, parsed).fingerprint !== expectedFingerprint) throw new RevisionConflict()
  const counts = store.importSigns(parsed.entries, parsed.source)
  return {
    ...withoutPreview(preview),
    ...counts,
    backup,
    catalog: store.latestSignCatalog(),
  }
}
