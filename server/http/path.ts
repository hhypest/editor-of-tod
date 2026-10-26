import { z } from 'zod'
import { RequestError } from './request-error.ts'

export function decodeKey(encoded: string): string {
  try {
    return decodeURIComponent(encoded)
  } catch {
    throw new RequestError(400, 'Неверный код в адресе.')
  }
}

export function projectId(encoded: string): string {
  const id = decodeKey(encoded)
  if (!z.uuid().safeParse(id).success) throw new RequestError(400, 'Неверный ID проекта.')
  return id
}
