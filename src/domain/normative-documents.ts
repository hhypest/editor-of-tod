import { z } from 'zod'

/**
 * Локальная библиотека нормативных документов: PDF ГОСТ, ОДМ и изменений к ним, которые
 * составитель прикрепляет в программе. Файлы хранятся только в локальной SQLite. Статус
 * «действует/заменён» вычисляется по датам введения, указанным составителем; приложение
 * не проверяет актуальность документа по внешним источникам.
 */
export const documentKinds = {
  signs: 'Изображения знаков (ГОСТ Р 52290)',
  rules: 'Правила применения (ГОСТ Р 52289 и др.)',
  methodology: 'Методические документы (ОДМ)',
  other: 'Прочее',
} as const
export type DocumentKind = keyof typeof documentKinds

const optionalDate = z.union([z.iso.date(), z.literal('')])

export const documentMetaSchema = z.strictObject({
  code: z.string().trim().min(3).max(120),
  edition: z.string().trim().min(1).max(60),
  title: z.string().trim().max(500),
  kind: z.enum(['signs', 'rules', 'methodology', 'other']),
  /** Дата введения в действие; пустая — неизвестна. */
  effectiveFrom: optionalDate,
  /** Для изменения к стандарту — документ, который оно изменяет. */
  amendsId: z.number().int().positive().nullable(),
  note: z.string().trim().max(2_000),
  /** Когда составитель последний раз проверял, что эта редакция действует. */
  actualCheckedAt: optionalDate,
})
export type DocumentMeta = z.infer<typeof documentMetaSchema>

export const documentRecordSchema = documentMetaSchema.extend({
  id: z.number().int().positive(),
  filename: z.string(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  sizeBytes: z.number().int().nonnegative(),
  addedAt: z.string(),
})
export type DocumentRecord = z.infer<typeof documentRecordSchema>

/** «гост р52290-2024» → «ГОСТ Р 52290»: год редакции хранится отдельно. */
export function normalizeDocumentCode(code: string): string {
  if (/^пдд(?:\s+рф|\s*[№N]\s*1090)?$/iu.test(code.trim())) return 'ПДД'
  return code
    .trim()
    .toLocaleUpperCase('ru-RU')
    .replace(/\s+/g, ' ')
    .replace(/^ГОСТ\s*Р\s*/u, 'ГОСТ Р ')
    .replace(/^ГОСТ(?=\d)/u, 'ГОСТ ')
    .replace(/^ОДМ(?=\d)/u, 'ОДМ ')
    .replace(/[-–—](19|20)\d{2}$/u, '')
    .trim()
}

const knownKinds: Array<[RegExp, DocumentKind]> = [
  [/^ПДД$/u, 'rules'],
  [/^ГОСТ Р 52290\b/u, 'signs'],
  [/^ГОСТ Р (52289|58350|50597)\b/u, 'rules'],
  [/^ОДМ(?:\s|$)/u, 'methodology'],
]

export function kindForCode(code: string): DocumentKind {
  const normalized = normalizeDocumentCode(code)
  return knownKinds.find(([pattern]) => pattern.test(normalized))?.[1] ?? 'other'
}

/**
 * Подсказка по имени файла: «GOST-R-52290-2024.pdf», «GOSTR52289-2019.pdf»,
 * «odm-218.6.019-2016.pdf». Составитель проверяет и исправляет поля перед записью.
 */
export function suggestFromFilename(
  filename: string,
): Pick<DocumentMeta, 'code' | 'edition' | 'kind'> {
  const name = filename.replace(/\.pdf$/i, '').replace(/[_–—−‑]/g, '-')
  if (/(?:^|[-\s])(?:пдд|pdd)(?:$|[-\s])/iu.test(name)) {
    const edition = /(?:19|20)\d{2}-\d{2}-\d{2}/u.exec(name)?.[0] ?? ''
    return {
      code: 'ПДД',
      edition: z.iso.date().safeParse(edition).success ? edition : '',
      kind: 'rules',
    }
  }
  const year = (value: string | undefined) => (value && /^(19|20)\d{2}$/.test(value) ? value : '')
  const gost =
    /(?<![\p{L}\d])(?:gost|гост)[-\s]*([rр])?[-\s]*(\d{4,6}(?:\.\d+)*)(?:[-\s]+((?:19|20)\d{2})(?!\d))?/iu.exec(
      name,
    )
  if (gost) {
    const code = `ГОСТ${gost[1] ? ' Р' : ''} ${gost[2]}`
    return { code, edition: year(gost[3]), kind: kindForCode(code) }
  }
  const odm =
    /(?<![\p{L}\d])(?:odm|одм)[-\s]*(\d{3}\.\d+\.\d+)(?:[-\s]+((?:19|20)\d{2})(?!\d))?/iu.exec(name)
  if (odm) {
    const code = `ОДМ ${odm[1]}`
    return { code, edition: year(odm[2]), kind: 'methodology' }
  }
  return { code: '', edition: '', kind: 'other' }
}

export type DocumentStatus =
  | { kind: 'current' }
  | { kind: 'superseded'; by: number }
  | { kind: 'future'; from: string }
  | { kind: 'undated' }
  | { kind: 'amendment'; of: number; inForce: boolean }

/** Дата, с которой редакция считается введённой: указанная или 1 января года редакции. */
function effectiveKey(document: DocumentRecord): string | null {
  if (document.effectiveFrom) return document.effectiveFrom
  // Дата постановления и дата редакции ПДД не определяют вступление изменений в силу.
  if (normalizeDocumentCode(document.code) === 'ПДД') return null
  return /^(19|20)\d{2}$/.test(document.edition) ? `${document.edition}-01-01` : null
}

/**
 * Статус каждой редакции на дату `today` (YYYY-MM-DD) среди документов с тем же кодом:
 * действующая — последняя введённая; более ранние заменены ею; более поздние ещё не введены.
 */
export function documentStatuses(
  documents: readonly DocumentRecord[],
  today: string,
): Map<number, DocumentStatus> {
  const statuses = new Map<number, DocumentStatus>()
  const groups = new Map<string, DocumentRecord[]>()
  const byId = new Map(documents.map((document) => [document.id, document]))
  for (const document of documents) {
    if (document.amendsId !== null) {
      const parent = byId.get(document.amendsId)
      const isPdd =
        normalizeDocumentCode(document.code) === 'ПДД' ||
        (parent !== undefined && normalizeDocumentCode(parent.code) === 'ПДД')
      // У изменяющего постановления свой код; год редакции тоже не определяет дату введения.
      const effective = isPdd ? document.effectiveFrom || null : effectiveKey(document)
      statuses.set(document.id, {
        kind: 'amendment',
        of: document.amendsId,
        inForce: effective !== null ? effective <= today : !isPdd,
      })
      continue
    }
    const key = normalizeDocumentCode(document.code)
    groups.set(key, [...(groups.get(key) ?? []), document])
  }
  for (const group of groups.values()) {
    const dated = group
      .filter((document) => effectiveKey(document) !== null)
      .sort((a, b) => effectiveKey(a)!.localeCompare(effectiveKey(b)!) || a.id - b.id)
    const inForce = dated.filter((document) => effectiveKey(document)! <= today)
    const current = inForce.at(-1) ?? null
    for (const document of dated) {
      if (document === current) statuses.set(document.id, { kind: 'current' })
      else if (effectiveKey(document)! > today)
        statuses.set(document.id, { kind: 'future', from: effectiveKey(document)! })
      else statuses.set(document.id, { kind: 'superseded', by: current!.id })
    }
    for (const document of group.filter((item) => effectiveKey(item) === null)) {
      // Без даты и года редакция считается действующей, только если она единственная.
      statuses.set(
        document.id,
        group.length === 1 && normalizeDocumentCode(document.code) !== 'ПДД'
          ? { kind: 'current' }
          : { kind: 'undated' },
      )
    }
  }
  return statuses
}

/** Действующая редакция документа с данным кодом или null. */
export function currentDocument(
  documents: readonly DocumentRecord[],
  code: string,
  today: string,
): DocumentRecord | null {
  const statuses = documentStatuses(documents, today)
  const key = normalizeDocumentCode(code)
  return (
    documents.find(
      (document) =>
        document.amendsId === null &&
        normalizeDocumentCode(document.code) === key &&
        statuses.get(document.id)?.kind === 'current',
    ) ?? null
  )
}

/** Ежегодная проверка актуальности: редакция не проверялась больше года. */
export function actualityCheckDue(document: DocumentRecord, today: string): boolean {
  if (!document.actualCheckedAt) return true
  const next = new Date(`${document.actualCheckedAt}T00:00:00Z`)
  next.setUTCFullYear(next.getUTCFullYear() + 1)
  return next.toISOString().slice(0, 10) <= today
}

export type CatalogEditionStatus =
  | { kind: 'no-catalog' }
  | { kind: 'no-document'; code: string }
  | { kind: 'current'; document: DocumentRecord }
  | { kind: 'outdated'; catalogEdition: string; document: DocumentRecord }

/**
 * Совпадает ли редакция источника знаков (каталога или закрепления проекта) с действующей
 * редакцией этого документа в библиотеке.
 */
export function catalogEditionStatus(
  source: { documentCode: string; edition: string } | null,
  documents: readonly DocumentRecord[],
  today: string,
): CatalogEditionStatus {
  if (!source) return { kind: 'no-catalog' }
  const document = currentDocument(documents, source.documentCode, today)
  if (!document) return { kind: 'no-document', code: normalizeDocumentCode(source.documentCode) }
  return document.edition.trim() === source.edition.trim()
    ? { kind: 'current', document }
    : { kind: 'outdated', catalogEdition: source.edition, document }
}

export function documentLabel(document: Pick<DocumentRecord, 'code' | 'edition'>): string {
  return `${normalizeDocumentCode(document.code)}-${document.edition}`
}
