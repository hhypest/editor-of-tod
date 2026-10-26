import { z } from 'zod'
import {
  pu66LifecycleWriteSchema,
  type Pu66LifecycleWrite,
  type Pu66LifecyclePlan,
} from '../src/domain/pu66-lifecycle.ts'
import { RevisionConflict } from './storage-errors.ts'

export interface Pu66LifecycleCommands {
  planPu66Lifecycle(input: Pu66LifecycleWrite): Pu66LifecyclePlan
  recordPu66Lifecycle(input: Pu66LifecycleWrite, expectedFingerprint: string): number
  createBackup(): Promise<string>
}

const applySchema = z.strictObject({
  input: pu66LifecycleWriteSchema,
  expectedFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
})

export async function applyPu66Lifecycle(store: Pu66LifecycleCommands, body: unknown) {
  const { input, expectedFingerprint } = applySchema.parse(body)
  if (store.planPu66Lifecycle(input).fingerprint !== expectedFingerprint)
    throw new RevisionConflict()
  const backup = await store.createBackup()
  // The synchronous transaction rechecks the entire plan after the asynchronous backup.
  const changed = store.recordPu66Lifecycle(input, expectedFingerprint)
  return { changed, backup }
}
