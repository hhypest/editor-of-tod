import type { z } from 'zod'
import { localJson } from './json-response'
import { invalidLocalApiResponse, localApiErrorForStatus, unavailableLocalApi } from './api-error'

/** HTTP and response decoding stay at the adapter boundary; never include payloads in errors. */
export async function requestLocalData(url: string, options?: RequestInit): Promise<unknown> {
  let response: Response
  try {
    response = await fetch(url, options)
  } catch {
    throw unavailableLocalApi('Программа не отвечает. Перезапустите её и повторите действие.')
  }
  let body: unknown
  try {
    body = await localJson(response)
  } catch (cause) {
    throw invalidLocalApiResponse(
      cause instanceof Error ? cause.message : 'Не удалось прочитать ответ программы.',
    )
  }
  if (!response.ok) {
    const message =
      body && typeof body === 'object' && 'error' in body && typeof body.error === 'string'
        ? body.error
        : `Ошибка локального реестра (${response.status}).`
    throw localApiErrorForStatus(response.status, message)
  }
  return body
}

export function parseLocalData<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body)
  if (!result.success)
    throw invalidLocalApiResponse('Программа получила неполные данные. Повторите загрузку.')
  return result.data
}
