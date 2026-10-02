import { z } from 'zod'
import { pu66LifecycleWriteSchema } from '../src/domain/pu66-lifecycle.ts'
import { RegistryStore, RevisionConflict } from './store.ts'

const applySchema = z.strictObject({
  input: pu66LifecycleWriteSchema,
  expectedFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
})

export async function applyPu66Lifecycle(store: RegistryStore, body: unknown) {
  const { input, expectedFingerprint } = applySchema.parse(body)
  if (store.planPu66Lifecycle(input).fingerprint !== expectedFingerprint)
    throw new RevisionConflict()
  const backup = await store.createBackup()
  // The synchronous transaction rechecks the entire plan after the asynchronous backup.
  const changed = store.recordPu66Lifecycle(input, expectedFingerprint)
  return { changed, backup }
}
