import { createHash } from 'node:crypto'
import { z } from 'zod'
import { normalizeDocumentCode } from '../src/domain/normative-documents.ts'
import {
  assignSignCodes,
  extractPdfSigns,
  yellowVariant,
  type PdfSignExtraction,
  type SignOverrides,
} from './sign-pdf.ts'
import { InvalidSignUpload } from './sign-web-import.ts'
import { RegistryStore, RevisionConflict, type SignCatalogSource } from './store.ts'

/**
 * Каталог знаков из PDF стандарта, прикреплённого в библиотеке нормативных документов.
 * Просмотр показывает найденные изображения и их номера; составитель может исправить номер
 * или исключить изображение, после чего подтверждает запись. Перед записью создаётся
 * резервная копия SQLite.
 */

const SIGN_NUMBER = /^\d{1,2}(\.\d{1,2}){1,3}$/
const requestSchema = z.strictObject({
  overrides: z
    .record(
      z.string().regex(/^\d{1,4}-\d{1,4}(\.\d{1,2})?$/),
      z
        .string()
        .trim()
        .regex(SIGN_NUMBER, 'Номер знака: цифры через точку, например 1.34.1.')
        .nullable(),
    )
    .default({}),
})
const applySchema = requestSchema.extend({
  expectedFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
})

/** Последнее извлечение: разбор PDF занимает несколько секунд, а просмотр повторяется. */
let cached: { sha256: string; result: Promise<PdfSignExtraction> } | null = null

function sourceDocument(store: RegistryStore, documentId: number) {
  const document = store.getDocument(documentId)
  if (!document) throw new InvalidSignUpload('Документ не найден в библиотеке.', 404)
  if (document.amendsId !== null)
    throw new InvalidSignUpload('Выберите основной документ, а не изменение к нему.')
  if (document.kind !== 'signs')
    throw new InvalidSignUpload(
      'Знаки извлекаются из документа с назначением «Изображения знаков (ГОСТ Р 52290)». Проверьте назначение документа в библиотеке.',
    )
  return document
}

export async function extractionFor(
  store: RegistryStore,
  documentId: number,
): Promise<PdfSignExtraction> {
  const document = sourceDocument(store, documentId)
  if (cached?.sha256 !== document.sha256) {
    const pdf = store.getDocumentPdf(documentId)?.pdf
    if (!pdf) throw new InvalidSignUpload('PDF документа не найден в локальной базе.', 404)
    const result = extractPdfSigns(pdf).catch((cause: unknown) => {
      cached = null
      throw new InvalidSignUpload(
        `Не удалось прочитать PDF: ${cause instanceof Error ? cause.message : 'неизвестная ошибка'}.`,
      )
    })
    cached = { sha256: document.sha256, result }
  }
  const extraction = await cached.result
  if (!extraction.images.length)
    throw new InvalidSignUpload(
      'В PDF не найдены изображения знаков: нет таблиц приложения А («Таблица А.1» … «Приложение Б») с растровыми изображениями. Если PDF отсканирован или устроен иначе, загрузите знаки из ZIP.',
    )
  return extraction
}

async function plan(store: RegistryStore, documentId: number, overrides: SignOverrides) {
  const document = sourceDocument(store, documentId)
  const extraction = await extractionFor(store, documentId)
  const known = new Set(extraction.images.map((image) => image.key))
  const unknown = Object.keys(overrides).filter((key) => !known.has(key))
  if (unknown.length)
    throw new InvalidSignUpload(`Нет изображений ${unknown.join(', ')} в этом PDF.`)
  const { assignments, entries, yellow } = assignSignCodes(extraction, overrides, document.sha256)
  const source: SignCatalogSource = {
    documentCode: normalizeDocumentCode(document.code),
    edition: document.edition,
    pdfSha256: document.sha256,
    documentId: document.id,
  }
  if (!entries.length) throw new InvalidSignUpload('Все изображения исключены из каталога.')
  const counts = store.planSigns(entries, source)
  const fingerprint = createHash('sha256')
    .update(
      JSON.stringify({
        source,
        codes: entries.map((entry) => [entry.code, entry.plainSha256]),
        counts,
        currentBatchId: store.latestSignCatalog()?.id ?? null,
      }),
    )
    .digest('hex')
  return { document, extraction, assignments, entries, yellow, source, counts, fingerprint }
}

function summary(result: Awaited<ReturnType<typeof plan>>) {
  const byKey = new Map(result.extraction.images.map((image) => [image.key, image]))
  return {
    document: {
      id: result.document.id,
      code: result.document.code,
      edition: result.document.edition,
    },
    pages: result.extraction.pages,
    yellowRule: result.extraction.yellow,
    yellowCodes: result.yellow,
    images: result.assignments.map((assignment) => {
      const image = byKey.get(assignment.key)!
      return {
        key: assignment.key,
        page: image.page,
        detected: image.code,
        example: image.example,
        code: assignment.code,
        reason: assignment.reason,
        width: image.width,
        height: image.height,
      }
    }),
    ...result.counts,
    signCount: result.entries.length,
    source: result.source,
    fingerprint: result.fingerprint,
  }
}

export async function previewPdfSigns(store: RegistryStore, documentId: number, body: unknown) {
  const { overrides } = requestSchema.parse(body)
  return summary(await plan(store, documentId, overrides))
}

export async function applyPdfSigns(store: RegistryStore, documentId: number, body: unknown) {
  const { expectedFingerprint, overrides } = applySchema.parse(body)
  const first = await plan(store, documentId, overrides)
  if (first.fingerprint !== expectedFingerprint) throw new RevisionConflict()
  // Изображение без номера не попало бы в каталог и могло бы молча исключить знак из текущего
  // набора: составитель должен указать номер или явно исключить изображение.
  const unresolved = first.assignments.filter((item) => item.reason === 'no-label')
  if (unresolved.length)
    throw new InvalidSignUpload(
      `У изображений ${unresolved
        .slice(0, 10)
        .map((item) => item.key)
        .join(
          ', ',
        )}${unresolved.length > 10 ? ' и других' : ''} не указан номер: укажите его или исключите изображение из каталога.`,
    )
  const result = {
    added: first.counts.added,
    updated: first.counts.updated,
    unchanged: first.counts.unchanged,
    retired: first.counts.retired,
    relabelled: first.counts.relabelled,
    addedCodes: first.counts.addedCodes,
    changedCodes: first.counts.changedCodes,
    retiredCodes: first.counts.retiredCodes,
    signCount: first.entries.length,
    source: first.source,
  }
  if (first.counts.added + first.counts.updated + first.counts.retired === 0)
    return { ...result, backup: null, catalog: store.latestSignCatalog() }
  const backup = await store.createBackup()
  const second = await plan(store, documentId, overrides)
  if (second.fingerprint !== expectedFingerprint) throw new RevisionConflict()
  store.importSigns(second.entries, second.source)
  return { ...result, backup, catalog: store.latestSignCatalog() }
}

/** PNG изображения из PDF для просмотра; yellow — вариант с жёлтым фоном. */
export async function pdfSignImage(
  store: RegistryStore,
  documentId: number,
  key: string,
  yellow: boolean,
): Promise<Buffer> {
  const extraction = await extractionFor(store, documentId)
  const image = extraction.images.find((item) => item.key === key)
  if (!image) throw new InvalidSignUpload('Изображение не найдено.', 404)
  return yellow ? yellowVariant(image.png) : image.png
}
