import { createHash } from 'node:crypto'
import { z } from 'zod'
import { parseSignArchive } from './signs.ts'
import { RegistryStore, RevisionConflict, type SignCatalogSource } from './store.ts'

const MAX_ZIP_BYTES = 32 * 1024 * 1024
const MAX_PDF_BYTES = 10 * 1024 * 1024
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

function parse(body: z.infer<typeof requestSchema>) {
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
  const source: SignCatalogSource = {
    documentCode: body.documentCode,
    edition: body.edition,
    pdfSha256: pdf ? createHash('sha256').update(pdf).digest('hex') : null,
  }
  return { entries, source }
}

function plan(store: RegistryStore, parsed: ReturnType<typeof parse>) {
  const counts = store.planSigns(parsed.entries, parsed.source)
  const catalog = store.latestSignCatalog()
  const fingerprint = createHash('sha256')
    .update(
      JSON.stringify({
        source: parsed.source,
        archive: parsed.entries[0]?.zipSha256,
        codes: parsed.entries.map((entry) => [entry.code, entry.numberedSha256, entry.plainSha256]),
        counts,
        currentBatchId: catalog?.id ?? null,
      }),
    )
    .digest('hex')
  return { ...counts, fingerprint, signCount: parsed.entries.length, source: parsed.source }
}

export function previewSignUpload(store: RegistryStore, body: unknown) {
  const parsed = parse(requestSchema.parse(body))
  return plan(store, parsed)
}

export async function applySignUpload(store: RegistryStore, body: unknown) {
  const { expectedFingerprint, ...request } = applySchema.parse(body)
  const parsed = parse(request)
  const preview = plan(store, parsed)
  if (preview.fingerprint !== expectedFingerprint) throw new RevisionConflict()
  if (preview.added + preview.updated + preview.retired === 0) {
    return { ...preview, backup: null, catalog: store.latestSignCatalog() }
  }
  const backup = await store.createBackup()
  if (plan(store, parsed).fingerprint !== expectedFingerprint) throw new RevisionConflict()
  const counts = store.importSigns(parsed.entries, parsed.source)
  return { ...counts, backup, catalog: store.latestSignCatalog() }
}
