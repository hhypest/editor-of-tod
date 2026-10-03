import { z } from 'zod'
import { findClause, findTable } from '../src/domain/document-text.ts'
import {
  currentDocument,
  documentLabel,
  documentStatuses,
} from '../src/domain/normative-documents.ts'
import {
  parameterDefinitions,
  confirmationMatchesDefinition,
  parameterValueSchema,
  relevantFragment,
  suggestValue,
  valueProblem,
  type ParameterConfirmation,
  type ParameterDefinition,
  type ParameterState,
  type ParameterRejectionReason,
  type ParameterRejectionField,
} from '../src/domain/normative-parameters.ts'
import { localCalendarDate } from '../src/domain/pu66-review.ts'
import { extractPdfText } from './pdf-text.ts'
import { RegistryStore, RevisionConflict } from './store.ts'

export class InvalidParameter extends Error {
  readonly status: number
  readonly reason: ParameterRejectionReason
  readonly field: ParameterRejectionField
  constructor(
    message: string,
    status = 400,
    reason: ParameterRejectionReason = 'invalid-request',
    field: ParameterRejectionField = 'request',
  ) {
    super(message)
    this.status = status
    this.reason = reason
    this.field = field
  }
}

export class ParameterConfirmationConflict extends RevisionConflict {
  readonly reason = 'document-changed'
  readonly field = 'document'
  constructor() {
    super()
    this.message =
      'Редакция документа изменилась. Обновите список параметров и сверьте новую цитату перед подтверждением; введённые данные сохранены.'
  }
}

/** Текст документа: из SQLite, а при первом обращении — из PDF (несколько секунд). */
export async function documentText(store: RegistryStore, id: number): Promise<string[]> {
  const saved = store.getDocumentText(id)
  if (saved) return saved
  const file = store.getDocumentPdf(id)
  if (!file) throw new InvalidParameter('PDF документа не найден.', 404, 'no-document', 'document')
  let pages: string[]
  try {
    pages = await extractPdfText(file.pdf)
  } catch {
    throw new InvalidParameter(
      'Не удалось прочитать текст PDF. Проверьте файл в библиотеке документов.',
      400,
      'pdf-unreadable',
      'document',
    )
  }
  store.saveDocumentText(id, pages)
  return pages
}

function latestConfirmations(store: RegistryStore): Map<string, ParameterConfirmation> {
  const latest = new Map<string, ParameterConfirmation>()
  for (const item of store.listParameterConfirmations()) latest.set(item.parameterId, item)
  return latest
}

async function quoteFor(store: RegistryStore, definition: ParameterDefinition, id: number) {
  const source = definition.source
  if (source.kind === 'decision') return null
  const pages = await documentText(store, id)
  if (source.kind === 'table') return findTable(pages, source.table)
  const clause = findClause(pages, source.clause)
  return clause ? { ...clause, rows: undefined } : null
}

/** Изменения к документу, которые уже действуют и упоминают пункт или таблицу параметра. */
async function amendmentsFor(
  store: RegistryStore,
  definition: ParameterDefinition,
  baseId: number,
  today: string,
): Promise<string[]> {
  const source = definition.source
  if (source.kind === 'decision') return []
  const documents = store.listDocuments()
  const statuses = documentStatuses(documents, today)
  const tableMention =
    source.kind === 'table'
      ? new RegExp(`таблиц[аеуы]\\s+${source.table.replace('.', '\\.')}(?!\\d|\\.\\d)`, 'iu')
      : new RegExp(`(?<![\\d.])${source.clause.replace(/\./g, '\\.')}(?!\\d|\\.\\d)`, 'u')
  const clauses =
    source.kind === 'table'
      ? (source.clause.match(/\d+(?:\.\d+)+/g) ?? []).map(
          (clause) => new RegExp(`(?<![\\d.])${clause.replace(/\./g, '\\.')}(?!\\d|\\.\\d)`, 'u'),
        )
      : []
  const result: string[] = []
  for (const amendment of documents.filter((document) => document.amendsId === baseId)) {
    const status = statuses.get(amendment.id)
    if (status?.kind !== 'amendment' || !status.inForce) continue
    const text = (await documentText(store, amendment.id)).join('\n')
    if (tableMention.test(text) || clauses.some((mention) => mention.test(text)))
      result.push(`${amendment.code} (${amendment.edition})`)
  }
  return result
}

/** Changes are part of the evidence, even when the base PDF has not changed. */
function confirmationFragment(
  store: RegistryStore,
  definition: ParameterDefinition,
  quote: { text: string } | null,
  amendments: readonly string[],
): string {
  const fragment = quote ? relevantFragment(definition, quote.text) : ''
  if (!amendments.length) return fragment
  const documents = store.listDocuments()
  const fingerprint = amendments
    .map((label) => {
      const document = documents.find((item) => `${item.code} (${item.edition})` === label)
      return `${label}:${document?.sha256 ?? ''}`
    })
    .join('|')
  return `${fragment}\nИзменения: ${fingerprint}`
}

export async function listParameterStates(
  store: RegistryStore,
  now = new Date(),
): Promise<ParameterState[]> {
  const today = localCalendarDate(now)
  const documents = store.listDocuments()
  const latest = latestConfirmations(store)
  const states: ParameterState[] = []
  for (const definition of parameterDefinitions) {
    const confirmation = latest.get(definition.id) ?? null
    const source = definition.source
    if (source.kind === 'decision') {
      states.push({
        id: definition.id,
        status: confirmation ? { kind: 'confirmed' } : { kind: 'unconfirmed' },
        document: null,
        quote: null,
        suggestion: null,
        confirmation,
        amendments: [],
      })
      continue
    }
    const current = currentDocument(documents, source.documentCode, today)
    if (!current) {
      states.push({
        id: definition.id,
        status: { kind: 'no-document' },
        document: null,
        quote: null,
        suggestion: null,
        confirmation,
        amendments: [],
      })
      continue
    }
    const quote = await quoteFor(store, definition, current.id)
    const amendments = await amendmentsFor(store, definition, current.id, today)
    const fragment = confirmationFragment(store, definition, quote, amendments)
    let status: ParameterState['status']
    if (!confirmation) status = { kind: 'unconfirmed' }
    else if (!confirmationMatchesDefinition(definition, confirmation))
      status = {
        kind: 'changed',
        previous: `${confirmation.documentLabel}, ${confirmation.clause}`,
      }
    else if (confirmation.documentId === current.id && confirmation.fragment === fragment)
      status = { kind: 'confirmed' }
    else if (confirmation.documentId === current.id)
      status = { kind: 'changed', previous: confirmation.documentLabel }
    else {
      const same =
        quote !== null && confirmation.fragment !== '' && fragment === confirmation.fragment
      status = { kind: same ? 'same-text' : 'changed', previous: confirmation.documentLabel }
    }
    states.push({
      id: definition.id,
      status,
      document: { id: current.id, label: documentLabel(current), sha256: current.sha256 },
      quote: quote
        ? { page: quote.page, text: quote.text, ...(quote.rows ? { rows: quote.rows } : {}) }
        : null,
      suggestion: suggestValue(definition, quote),
      confirmation,
      amendments,
    })
  }
  return states
}

const confirmSchema = z.strictObject({
  value: parameterValueSchema,
  confirmedBy: z.string().trim().min(2).max(240),
  note: z.string().trim().max(2_000),
  /** Документ, цитату которого видел составитель; null — решение без документа. */
  expectedDocumentId: z.number().int().positive().nullable(),
})

export async function confirmParameter(
  store: RegistryStore,
  parameterId: string,
  body: unknown,
  now = new Date(),
): Promise<ParameterConfirmation> {
  const definition = parameterDefinitions.find((item) => item.id === parameterId)
  if (!definition)
    throw new InvalidParameter('Неизвестный нормативный параметр.', 404, 'unknown-parameter')
  const parsed = confirmSchema.safeParse(body)
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path[0]
    if (field === 'value')
      throw new InvalidParameter(
        'Введите допустимое число или таблицу значений.',
        400,
        'invalid-value',
        'value',
      )
    if (field === 'confirmedBy')
      throw new InvalidParameter(
        'Укажите, кто подтверждает: от 2 до 240 символов.',
        400,
        'invalid-request',
        'confirmedBy',
      )
    if (field === 'note')
      throw new InvalidParameter(
        'Примечание должно быть текстом не длиннее 2000 символов.',
        400,
        'invalid-request',
        'note',
      )
    if (field === 'expectedDocumentId')
      throw new InvalidParameter(
        'Неверная ссылка на документ. Обновите список параметров.',
        400,
        'invalid-request',
        'document',
      )
    throw new InvalidParameter(
      'Неверные данные подтверждения. Обновите программу и повторите проверку.',
    )
  }
  const input = parsed.data
  const problem = valueProblem(definition, input.value)
  if (problem) throw new InvalidParameter(problem, 400, 'invalid-value', 'value')
  const today = localCalendarDate(now)
  const base = {
    parameterId,
    value: input.value,
    confirmedBy: input.confirmedBy,
    confirmedAt: today,
    note: input.note,
  }
  const source = definition.source
  if (source.kind === 'decision') {
    if (!input.note)
      throw new InvalidParameter(
        'Укажите основание решения: документ, расчёт или распоряжение.',
        400,
        'note-required',
        'note',
      )
    return store.addParameterConfirmation({
      ...base,
      documentId: null,
      documentLabel: '',
      clause: '',
      page: null,
      quote: '',
      fragment: '',
    })
  }
  const current = currentDocument(store.listDocuments(), source.documentCode, today)
  if (!current)
    throw new InvalidParameter(
      `Прикрепите действующую редакцию ${source.documentCode} в библиотеке.`,
      400,
      'no-document',
      'document',
    )
  if (input.expectedDocumentId !== current.id) throw new ParameterConfirmationConflict()
  const quote = await quoteFor(store, definition, current.id)
  const amendments = await amendmentsFor(store, definition, current.id, today)
  const fragment = confirmationFragment(store, definition, quote, amendments)
  if (currentDocument(store.listDocuments(), source.documentCode, today)?.id !== current.id)
    throw new ParameterConfirmationConflict()
  if (!quote && !input.note)
    throw new InvalidParameter(
      'Пункт не найден в тексте PDF: укажите в примечании страницу и формулировку, по которым проверено значение.',
      400,
      'source-not-found',
      'note',
    )
  return store.addParameterConfirmation({
    ...base,
    documentId: current.id,
    documentLabel: documentLabel(current),
    clause: source.kind === 'table' ? source.clause : `п. ${source.clause}`,
    page: quote?.page ?? null,
    quote: quote?.text ?? '',
    fragment,
  })
}
