import { z } from 'zod'
import { kindForCode, suggestFromFilename } from './normative-documents.ts'

const suggestionSchema = z.strictObject({
  code: z.string().max(120),
  edition: z.string().max(60),
  kind: z.enum(['signs', 'rules', 'methodology', 'other']),
})
export const documentCandidateSchema = suggestionSchema.extend({
  title: z.string().max(500),
  documentType: z.enum(['base', 'amendment', 'correction']),
  baseEdition: z.string(),
  page: z.number().int().positive(),
})
export type DocumentCandidate = z.infer<typeof documentCandidateSchema>
export const documentIdentificationSchema = z.strictObject({
  status: z.enum(['identified', 'ambiguous', 'unrecognized', 'no-text']),
  candidates: z.array(documentCandidateSchema),
  filenameSuggestion: suggestionSchema,
  filenameConflict: z.boolean(),
  pagesRead: z.number().int().nonnegative(),
})
export type DocumentIdentification = z.infer<typeof documentIdentificationSchema>

/** Обозначения в заголовках, включая переносы между ГОСТ, Р, номером и годом. */
function designations(text: string) {
  return text.matchAll(
    /(?<![\p{L}\d])(?:(?:ГОСТ|GOST)[\s-]*([РR])?[\s-]*(\d{4,6}(?:\.\d+)*)|(?:ОДМ|ODM)[\s-]*(\d{3}\.\d+\.\d+))[\s-]+((?:19|20)\d{2})(?!\d)/giu,
  )
}

function candidatesOnPage(raw: string, page: number): DocumentCandidate[] {
  const text = raw.replace(/[–—−‑]/g, '-').replace(/\r/g, '')
  const result = new Map<string, DocumentCandidate>()
  for (const match of designations(text)) {
    const before = text.slice(0, match.index)
    // Обозначения из нормативных ссылок и библиографии не являются заголовком файла.
    if (/(?:нормативные ссылки|библиография)/iu.test(before)) continue
    const prefix = before.slice(before.lastIndexOf('\n') + 1).trim()
    const changeHeading = /^(Изменение\s*(?:№|N)?\s*(\d+)\s*(?:к)?|Поправка\s*(?:к)?)$/iu
    const change =
      changeHeading.exec(prefix) ??
      changeHeading.exec(before.trimEnd().split('\n').at(-1)?.trim() ?? '') ??
      changeHeading.exec(before.trimEnd().split('\n').slice(-2).join(' ').trim())
    // Допускается отдельная строка обозначения или заголовок изменения/поправки.
    // Внутритекстовые «по ГОСТ», «взамен ГОСТ» и перечни документов не подходят.
    if (prefix && !/^["«“]$/.test(prefix) && !change) continue
    const line = before.split('\n').length
    if (line > 16) continue
    const code = match[3] ? `ОДМ ${match[3]}` : `ГОСТ${match[1] ? ' Р' : ''} ${match[2]}`
    const baseEdition = match[4]!
    const documentType = !change ? 'base' : change[2] ? 'amendment' : 'correction'
    const edition =
      documentType === 'base'
        ? baseEdition
        : documentType === 'amendment'
          ? `Изменение № ${change![2]}`
          : 'Поправка'
    const following = text
      .slice(match.index + match[0].length)
      .replace(/^[.,:\s]+/, '')
      .trim()
      .split('\n')
    const title = following
      .slice(0, 4)
      .map((value) => value.trim())
      .filter((value) => value && !/^\d+$/.test(value))
      .filter(
        (value) =>
          !/^(?:дата введения|издание|предисловие|официальное|ГОСТ|ОДМ|Москва)/iu.test(value),
      )
      .join(' ')
      .slice(0, 500)
    const candidate: DocumentCandidate = {
      code,
      edition,
      kind: kindForCode(code),
      title,
      documentType,
      baseEdition,
      page,
    }
    result.set(`${code}/${edition}`, candidate)
  }
  return [...result.values()]
}

/**
 * Первая страница с подходящим заголовком имеет приоритет. На следующих страницах
 * ищем только при отсутствии заголовка: ссылки из основного текста не заменяют титул.
 * Результат — предложение составителю, а не подтверждение редакции или актуальности.
 */
export function identifyDocument(
  pages: readonly string[],
  filename: string,
): DocumentIdentification {
  const filenameSuggestion = suggestFromFilename(filename)
  let candidates: DocumentCandidate[] = []
  for (const [index, page] of pages.entries()) {
    candidates = candidatesOnPage(page, index + 1)
    if (candidates.length) break
  }
  const filenameConflict =
    Boolean(filenameSuggestion.code) &&
    candidates.some(
      (candidate) =>
        candidate.code !== filenameSuggestion.code ||
        (filenameSuggestion.edition !== '' && filenameSuggestion.edition !== candidate.baseEdition),
    )
  return {
    status:
      candidates.length > 1
        ? 'ambiguous'
        : candidates.length === 1
          ? 'identified'
          : pages.some((page) => page.trim())
            ? 'unrecognized'
            : 'no-text',
    candidates,
    filenameSuggestion,
    filenameConflict,
    pagesRead: pages.length,
  }
}
