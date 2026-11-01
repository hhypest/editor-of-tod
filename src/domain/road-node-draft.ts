import { z } from 'zod'

/** Recoverable form input, including incomplete/invalid numbers; not a persisted road node. */
export const roadNodeDraftSchema = z.strictObject({
  kind: z.literal('road-node'),
  id: z.number().int().positive().nullable(),
  nodeKind: z.enum(['junction', 'terminal-tee']),
  approach: z.enum(['left', 'right']),
  side: z.enum(['up', 'down']),
  roadKind: z.enum(['road', 'yard']),
  name: z.string().max(5_000),
  branchUp: z.string().max(5_000),
  branchDown: z.string().max(5_000),
  metres: z.string().max(5_000),
  sideWarningRequested: z.boolean(),
})

export type RoadNodeDraft = z.infer<typeof roadNodeDraftSchema>
