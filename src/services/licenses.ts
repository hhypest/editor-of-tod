import { z } from 'zod'
import { parseLocalData, requestLocalData } from './local-data'

const thirdPartySchema = z.object({
  groups: z.array(
    z.object({
      title: z.string(),
      packages: z.array(
        z.object({
          name: z.string(),
          version: z.string(),
          license: z.string(),
          homepage: z.string().nullable(),
        }),
      ),
    }),
  ),
  node: z.object({ version: z.string(), license: z.string() }).nullable(),
})
export type ThirdParty = z.infer<typeof thirdPartySchema>

export async function loadThirdPartyLicenses(): Promise<ThirdParty> {
  return parseLocalData(thirdPartySchema, await requestLocalData('/legal/third-party.json'))
}
