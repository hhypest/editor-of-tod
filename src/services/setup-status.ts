import { z } from 'zod'
import { parseLocalData, requestLocalData } from './local-data'

export interface SetupRegistryStatus {
  cards: number
  signs: number
  projects: number
}

/** The existing endpoints and their list limits are preserved; this is not a readiness verdict. */
export async function loadSetupStatus(): Promise<SetupRegistryStatus> {
  const rows = await Promise.all(
    ['/api/pu66', '/api/signs', '/api/projects'].map(async (url) =>
      parseLocalData(z.array(z.unknown()), await requestLocalData(url)),
    ),
  )
  return { cards: rows[0]!.length, signs: rows[1]!.length, projects: rows[2]!.length }
}
