import { z } from 'zod'
import type { ReviewFinding } from './review-scheme'

export const exclusionReasons = {
  reassigned: 'Передан другому подразделению',
  closed: 'Путь разобран или переезд закрыт',
  mistaken: 'Ошибочный импорт',
  other: 'Другая причина',
} as const

export const pu66LifecycleEventSchema = z.strictObject({
  id: z.number().int().positive(),
  action: z.enum(['exclude', 'restore']),
  date: z.iso.date(),
  actor: z.string(),
  reason: z.enum(['reassigned', 'closed', 'mistaken', 'other']).nullable(),
  comment: z.string(),
  successorKey: z.string().nullable(),
  cardRevision: z.number().int().positive(),
  recordedAt: z.iso.datetime(),
})
export const pu66StatusSchema = z.strictObject({
  referenceId: z.string(),
  excluded: z.boolean(),
  event: pu66LifecycleEventSchema.nullable(),
  successorKey: z.string().nullable(),
})
export type Pu66Status = z.infer<typeof pu66StatusSchema>

const keys = z
  .array(z.string().trim().min(1).max(120))
  .min(1)
  .max(100)
  .refine((values) => new Set(values).size === values.length, 'Карточки в списке повторяются.')
const common = { keys, date: z.iso.date(), actor: z.string().trim().min(1).max(240) }
export const pu66ImportRestoreSchema = z.strictObject(common)
export type Pu66ImportRestore = z.infer<typeof pu66ImportRestoreSchema>
export const pu66LifecycleWriteSchema = z.discriminatedUnion('action', [
  z
    .strictObject({
      ...common,
      action: z.literal('exclude'),
      reason: z.enum(['reassigned', 'closed', 'mistaken', 'other']),
      comment: z.string().trim().max(2000),
      successorKey: z.string().trim().min(1).max(120).nullable(),
    })
    .refine(
      (input) => input.reason !== 'other' || input.comment.length > 0,
      'Для другой причины укажите пояснение.',
    ),
  z.strictObject({ ...common, action: z.literal('restore'), comment: z.string().trim().max(2000) }),
])
export type Pu66LifecycleWrite = z.infer<typeof pu66LifecycleWriteSchema>
export const pu66LifecyclePlanSchema = z.strictObject({
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  items: z.array(
    z.strictObject({
      referenceId: z.string(),
      location: z.string(),
      roadName: z.string(),
      revision: z.number().int().positive(),
      status: pu66StatusSchema,
    }),
  ),
})
export type Pu66LifecyclePlan = z.infer<typeof pu66LifecyclePlanSchema>

/** Metadata stays in the database. Projects keep their original PU-66 snapshot. */
export function pu66StatusFinding(status: Pu66Status | null, unavailable = false): ReviewFinding[] {
  if (unavailable)
    return [
      {
        id: 'pu66-status',
        kind: 'verify',
        title: 'Статус карточки ПУ-66',
        detail: 'Не удалось проверить локальный статус карточки. Обновите реестр перед выпуском.',
        target: '#pu66-link-title',
        markBlocked: 'Локальный статус карточки недоступен.',
      },
    ]
  if (!status?.excluded || !status.event) return []
  const event = status.event
  return [
    {
      id: 'pu66-status',
      kind: 'verify',
      title: 'Карточка ПУ-66 исключена',
      detail:
        `Исключена ${event.date}: ${event.reason ? exclusionReasons[event.reason] : ''}. ${event.comment}` +
        (status.successorKey ? ` Преемник: ${status.successorKey}.` : '') +
        ' Проверьте допустимость использования сохранённого снимка или перепривяжите проект.',
      target: '#pu66-link-title',
      basis: JSON.stringify(status),
    },
  ]
}
