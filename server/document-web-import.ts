import { createHash } from 'node:crypto'
import { z } from 'zod'
import {
  documentMetaSchema,
  documentStatuses,
  normalizeDocumentCode,
  type DocumentRecord,
} from '../src/domain/normative-documents.ts'
import { localCalendarDate } from '../src/domain/pu66-review.ts'
import { RegistryStore, RevisionConflict } from './store.ts'
import { identifyDocument } from '../src/domain/document-identification.ts'
import { extractPdfText } from './pdf-text.ts'

export const MAX_DOCUMENT_BYTES = 40 * 1024 * 1024
/** base64 PDF до 40 МБ и сведения о документе. */
export const DOCUMENT_UPLOAD_REQUEST_BYTES = 56 * 1024 * 1024

const fileSchema = z.strictObject({
  file: z.strictObject({
    name: z
      .string()
      .min(1)
      .max(240)
      .regex(/\.pdf$/i),
    data: z.string().min(1),
  }),
})
const requestSchema = fileSchema.extend({ meta: documentMetaSchema })
const applySchema = requestSchema.extend({
  expectedFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
})

export class InvalidDocumentUpload extends Error {
  readonly status: number
  constructor(message: string, status = 400) {
    super(message)
    this.status = status
  }
}

function decode(data: string): Buffer {
  if (data.length > Math.ceil(MAX_DOCUMENT_BYTES / 3) * 4)
    throw new InvalidDocumentUpload('PDF больше 40 МБ.', 413)
  const bytes = Buffer.from(data, 'base64')
  if (bytes.length > MAX_DOCUMENT_BYTES) throw new InvalidDocumentUpload('PDF больше 40 МБ.', 413)
  if (bytes.toString('base64') !== data) throw new InvalidDocumentUpload('Неверные данные файла.')
  if (!bytes.subarray(0, 5).equals(Buffer.from('%PDF-')))
    throw new InvalidDocumentUpload('Выбранный файл не является PDF.')
  return bytes
}

/** Чтение первых восьми страниц без записи документа или резервной копии. */
export async function identifyDocumentUpload(body: unknown) {
  const input = fileSchema.parse(body)
  const pdf = decode(input.file.data)
  let pages: string[]
  try {
    pages = await extractPdfText(pdf, 8)
  } catch {
    throw new InvalidDocumentUpload(
      'Не удалось прочитать PDF. Проверьте файл; сведения можно заполнить вручную.',
    )
  }
  return identifyDocument(pages, input.file.name)
}

/** Что изменится в библиотеке после добавления: какая редакция станет действующей. */
function effect(existing: DocumentRecord[], candidate: DocumentRecord, today: string) {
  const documents = [...existing, candidate]
  const status = documentStatuses(documents, today).get(candidate.id)!
  const key = normalizeDocumentCode(candidate.code)
  const previousStatuses = documentStatuses(existing, today)
  const previousCurrent = existing.filter(
    (document) =>
      document.amendsId === null &&
      normalizeDocumentCode(document.code) === key &&
      previousStatuses.get(document.id)?.kind === 'current',
  )
  return {
    status,
    replaces:
      status.kind === 'current' && candidate.amendsId === null
        ? previousCurrent.map((document) => ({
            id: document.id,
            code: document.code,
            edition: document.edition,
          }))
        : [],
  }
}

function plan(store: RegistryStore, body: z.infer<typeof requestSchema>, today: string) {
  const pdf = decode(body.file.data)
  const sha256 = createHash('sha256').update(pdf).digest('hex')
  const filename = body.file.name.split(/[\\/]/).at(-1) ?? body.file.name
  const documents = store.listDocuments()
  const duplicate = documents.find((document) => document.sha256 === sha256) ?? null
  const candidate: DocumentRecord = {
    ...body.meta,
    id: Number.MAX_SAFE_INTEGER,
    filename,
    sha256,
    sizeBytes: pdf.byteLength,
    addedAt: '',
  }
  const fingerprint = createHash('sha256')
    .update(
      JSON.stringify({
        sha256,
        filename,
        today,
        meta: body.meta,
        documents,
      }),
    )
    .digest('hex')
  return {
    pdf,
    filename,
    preview: {
      sha256,
      sizeBytes: pdf.byteLength,
      filename,
      duplicate,
      effect: effect(documents, candidate, today),
      fingerprint,
    },
  }
}

export function previewDocumentUpload(store: RegistryStore, body: unknown, now = new Date()) {
  return plan(store, requestSchema.parse(body), localCalendarDate(now)).preview
}

export async function applyDocumentUpload(store: RegistryStore, body: unknown, now?: Date) {
  const { expectedFingerprint, ...request } = applySchema.parse(body)
  const today = () => localCalendarDate(now ?? new Date())
  const first = plan(store, request, today())
  if (first.preview.fingerprint !== expectedFingerprint) throw new RevisionConflict()
  if (first.preview.duplicate)
    throw new InvalidDocumentUpload('Этот PDF уже есть в библиотеке.', 409)
  const backup = await store.createBackup()
  if (plan(store, request, today()).preview.fingerprint !== expectedFingerprint)
    throw new RevisionConflict()
  const document = store.addDocument(request.meta, first.filename, first.pdf, first.preview.sha256)
  return { document, backup }
}
