import { z } from 'zod'

const label = z.string().trim().max(240)
const requiredLabel = label.min(1)
const optionalDate = z.union([z.iso.date(), z.literal('')])

export const crossingDraftSchema = z.strictObject({
  referenceId: z.string().trim().min(1).max(120),
  railwayLocation: label,
  roadName: label,
  roadOwner: label,
  cardReference: label,
  cardUpdatedAt: optionalDate,
  verifiedAt: optionalDate,
  notes: z.string().trim().max(5_000),
})

export const normativeDraftSchema = z
  .strictObject({
    id: z.string().regex(/^[a-z0-9][a-z0-9._-]{1,79}$/),
    documentCode: requiredLabel,
    edition: requiredLabel,
    clause: requiredLabel,
    description: z.string().trim().min(1).max(2_000),
    application: z.string().trim().max(2_000),
    sourceUrl: z.union([z.url().max(1_000), z.literal('')]),
    reviewStatus: z.enum(['needs-review', 'checked']),
    checkedAt: optionalDate,
    reviewer: label,
  })
  .superRefine((entry, context) => {
    if (entry.reviewStatus === 'checked' && (!entry.checkedAt || !entry.reviewer)) {
      context.addIssue({
        code: 'custom',
        path: ['reviewStatus'],
        message: 'Для проверенной записи нужны дата и ответственный',
      })
    }
  })

export const crossingWriteSchema = crossingDraftSchema.extend({
  expectedRevision: z.number().int().nonnegative(),
})
export const normativeWriteSchema = normativeDraftSchema.safeExtend({
  expectedRevision: z.number().int().nonnegative(),
})

export type CrossingDraft = z.infer<typeof crossingDraftSchema>
export type NormativeDraft = z.infer<typeof normativeDraftSchema>
export type CrossingRecord = CrossingDraft & { revision: number; updatedAt: string }
export type NormativeRecord = NormativeDraft & { revision: number; updatedAt: string }

/** Project selection policy, not an automatic statement of regulatory compliance. */
export function selectTemplateByWorkFront(lengthMetres: number): {
  code: 'b33' | 'b34'
  boundaryNeedsReview: boolean
} {
  if (!Number.isFinite(lengthMetres) || lengthMetres <= 0) {
    throw new RangeError('Длина фронта работ должна быть положительным числом в метрах.')
  }
  return { code: lengthMetres < 30 ? 'b34' : 'b33', boundaryNeedsReview: lengthMetres === 30 }
}

/** Обозначение рисунка ОДМ для кода шаблона: «Б.33», «Б.34» (кириллица, с точкой). */
export function templateLabel(code: string): string {
  const match = /^b(\d+)$/i.exec(code)
  return match ? `Б.${match[1]}` : code
}
