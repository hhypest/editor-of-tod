import { z } from 'zod'
import { schemeSchema } from './model.ts'

export const MAX_LOCAL_PROJECT_BYTES = 32 * 1024 * 1024

export const projectWriteSchema = z.strictObject({
  scheme: schemeSchema,
  expectedRevision: z.number().int().nonnegative(),
})

export const projectRestoreSchema = z.strictObject({
  sourceRevision: z.number().int().positive(),
  expectedRevision: z.number().int().positive(),
})

export const projectRecordSchema = z.strictObject({
  scheme: schemeSchema,
  revision: z.number().int().positive(),
  updatedAt: z.iso.datetime(),
})

export const projectSummarySchema = z.strictObject({
  id: z.uuid(),
  referenceId: z.string(),
  locationText: z.string(),
  templateCode: z.enum(['b33', 'b34']),
  revision: z.number().int().positive(),
  updatedAt: z.iso.datetime(),
})

export const projectRevisionSchema = projectRecordSchema.pick({ revision: true, updatedAt: true })

export type ProjectSummary = z.infer<typeof projectSummarySchema>
export type ProjectRecord = z.infer<typeof projectRecordSchema>
export type ProjectRevision = z.infer<typeof projectRevisionSchema>
