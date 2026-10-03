import { z } from 'zod'
import {
  confirmationSchema,
  parameterStateSchema,
  parameterRejectionSchema,
  type ParameterRejectionReason,
  type ParameterRejectionField,
  type ParameterConfirmation,
  type ParameterState,
  type ParameterValue,
} from '../domain/normative-parameters'
import type { Pu66Norms } from '../domain/pu66-norms'
import { localJson } from './json-response'

export class ParameterRequestError extends Error {
  readonly reason: ParameterRejectionReason
  readonly field: ParameterRejectionField
  constructor(message: string, reason: ParameterRejectionReason, field: ParameterRejectionField) {
    super(message)
    this.reason = reason
    this.field = field
  }
}

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
  const rejection = parameterRejectionSchema.safeParse(result)
  if (!response.ok && rejection.success)
    throw new ParameterRequestError(
      rejection.data.error,
      rejection.data.reason,
      rejection.data.field,
    )
  if (!response.ok)
    throw new Error(
      result && typeof result === 'object' && 'error' in result && typeof result.error === 'string'
        ? result.error
        : `Ошибка локального реестра (${response.status}).`,
    )
  return result
}

export async function listParameterStates(): Promise<ParameterState[]> {
  return parameterStateSchema.array().parse(await send('/api/normative-parameters', 'GET'))
}

export async function confirmParameter(
  id: string,
  input: {
    value: ParameterValue
    confirmedBy: string
    note: string
    expectedDocumentId: number | null
  },
): Promise<ParameterConfirmation> {
  return confirmationSchema.parse(
    await send(`/api/normative-parameters/${encodeURIComponent(id)}/confirm`, 'POST', input),
  )
}

const cell = z.union([z.string(), z.number(), z.null()])
const normsSchema = z.strictObject({
  referenceId: z.string(),
  roadCategory: cell,
  carCountPerDay: cell,
  trainCountPerDay: cell,
  trainVisibilityMetres: z.strictObject({
    rightOdd: cell,
    rightEven: cell,
    leftOdd: cell,
    leftEven: cell,
  }),
  years: z.strictObject({ previous: z.string(), current: z.string() }),
  technicalRows: z.array(
    z.strictObject({
      item: z.string(),
      label: z.string(),
      statedNorm: cell,
      previous: cell,
      current: cell,
    }),
  ),
  revision: z.number(),
  updatedAt: z.string(),
})

/** Нормативные сведения закреплённой карточки ПУ-66; null — карточки нет в локальной базе. */
export async function getPu66Norms(referenceId: string): Promise<Pu66Norms | null> {
  let response: Response
  try {
    response = await fetch(`/api/pu66/${encodeURIComponent(referenceId)}/norms`)
  } catch {
    throw new Error('Локальный реестр недоступен.')
  }
  if (response.status === 404) return null
  const result = await localJson(response)
  if (!response.ok) throw new Error('Не удалось прочитать карточку ПУ-66.')
  return normsSchema.parse(result)
}
