import { z } from 'zod'

const cell = z.union([z.string().max(2_000), z.number().finite(), z.null()])

/** Only fields currently selected for a scheme, plus the local record version. */
export const pu66SchemeRecordSchema = z.strictObject({
  referenceId: z.string().min(1).max(120),
  location: z.string().max(500),
  axisLabel: z.string().max(500),
  roadName: z.string().max(2_000),
  crossingWidthMetres: cell,
  /** Фактическая длина проезжей части в границах переезда, п. 8 ПУ-66. */
  crossingRoadLengthMetres: cell.default(null),
  revision: z.number().int().positive(),
  updatedAt: z.iso.datetime(),
})

export const pu66SnapshotSchema = pu66SchemeRecordSchema.omit({ referenceId: true })
export type Pu66SchemeRecord = z.infer<typeof pu66SchemeRecordSchema>
