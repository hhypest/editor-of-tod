import { z } from 'zod'
import { recoveryWriteSchema } from '../domain/recovery.ts'

export const recoveryOwnerSchema = z.strictObject({ ownerId: z.uuid() })
export const recoveryClaimSchema = recoveryOwnerSchema.extend({
  expectedVersion: z.number().int().positive(),
})
// The HTTP adapter restores a source reference, then validates the complete Scheme.
export const recoveryTransferSchema = recoveryWriteSchema.omit({ scheme: true }).extend({
  ownerId: z.uuid(),
  scheme: z.unknown(),
  sourceSha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
})
export const recoveryReceiptSchema = z.strictObject({
  version: z.number().int().positive(),
  updatedAt: z.iso.datetime(),
  sourceSha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
})
