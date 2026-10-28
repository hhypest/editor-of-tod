import { z } from 'zod'

const cell = z.union([z.string().max(2_000), z.number().finite(), z.null()])

const visibilityRowSchema = z.strictObject({
  item: z.string().max(40),
  label: z.string().max(2_000),
  previous: cell,
  current: cell,
})

/** Approved source values only; no norms, personnel or full technical table. */
export const pu66VisibilitySchema = z.strictObject({
  train: z.strictObject({ rightOdd: cell, rightEven: cell, leftOdd: cell, leftEven: cell }),
  years: z.strictObject({ previous: z.string().max(40), current: z.string().max(40) }),
  technical: z.array(visibilityRowSchema).max(100),
})

/** Approved fields for a scheme. Optional additions preserve old snapshots verbatim. */
export const pu66SchemeRecordSchema = z.strictObject({
  referenceId: z.string().min(1).max(120),
  location: z.string().max(500),
  axisLabel: z.string().max(500),
  roadName: z.string().max(2_000),
  crossingWidthMetres: cell,
  /** Фактическая длина проезжей части в границах переезда, п. 8 ПУ-66. */
  crossingRoadLengthMetres: cell.default(null),
  railwayLocation: z
    .strictObject({ section: z.string().max(2_000), station: z.string().max(2_000) })
    .optional(),
  visibility: pu66VisibilitySchema.optional(),
  revision: z.number().int().positive(),
  updatedAt: z.iso.datetime(),
})

export const pu66SnapshotSchema = pu66SchemeRecordSchema.omit({ referenceId: true })
export type Pu66SchemeRecord = z.infer<typeof pu66SchemeRecordSchema>

export type Pu66Snapshot = z.infer<typeof pu66SnapshotSchema>
