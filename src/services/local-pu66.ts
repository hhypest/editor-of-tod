import { z } from 'zod'
import { pu66SchemeRecordSchema, type Pu66SchemeRecord } from '../domain/pu66-snapshot'

const pu66ListEntrySchema = z.object({
  referenceId: z.string(),
  location: z.string(),
  roadName: z.string(),
  revision: z.number().int().positive(),
})
export type Pu66ListEntry = z.infer<typeof pu66ListEntrySchema>

async function request(url: string): Promise<unknown> {
  let response: Response
  try {
    response = await fetch(url)
  } catch {
    throw new Error('Локальный реестр недоступен. Запустите npm run dev или npm run local.')
  }
  if (!response.ok) throw new Error(`Не удалось прочитать карточку ПУ-66 (${response.status}).`)
  return response.json()
}

export async function listPu66Cards(): Promise<Pu66ListEntry[]> {
  return pu66ListEntrySchema.array().parse(await request('/api/pu66'))
}

export async function getPu66SchemeRecord(key: string): Promise<Pu66SchemeRecord> {
  return pu66SchemeRecordSchema.parse(await request(`/api/pu66/${encodeURIComponent(key)}/scheme`))
}
