import { z } from 'zod'
import { schemeSchema, upgradeTitleBlock } from './model.ts'
import { decisionEvidenceSchema, speedConditionsSchema } from './decision-evidence-schema.ts'

const text = z.string().max(5_000)
const zone = z.strictObject({
  taperMetres: text,
  bufferMetres: text,
  workMetres: text,
  labels: z.strictObject({ taper: text, buffer: text, work: text }),
})

const titleBlockV5DraftSchema = z.strictObject({
  developer: z.strictObject({ organization: text, name: text, date: text }),
  work: z.strictObject({ organization: text, description: text, period: text }),
  responsible: z.tuple([text, text]),
  approver: z.strictObject({ position: text, organization: text, name: text }),
  agreement: z.strictObject({ position: text, name: text, year: text }),
})

export const detailsDraftSchema = z.strictObject({
  decisionEvidence: decisionEvidenceSchema.optional(),
  decisionNotes: z.strictObject({ speed: text, regulation: text }).optional(),
  // Копии до 01.10.2026 (v6) хранят «скорость в населённом пункте» — она становится скоростью
  // на подходе, кроме местоположения «вне населённого пункта», где поле не использовалось.
  parameters: z.preprocess(
    (value) => {
      if (!value || typeof value !== 'object' || !('settlementSpeedKmh' in value)) return value
      const { settlementSpeedKmh, ...rest } = value as Record<string, unknown>
      return {
        ...rest,
        approachSpeedKmh: rest.location === 'out' ? '' : settlementSpeedKmh,
      }
    },
    z.strictObject({
      locationText: text,
      directions: z.strictObject({ left: text, right: text }),
      signDistancesMetres: z.strictObject({
        d300: text,
        d250: text,
        d150: text,
        d50: text,
        n100: text,
        n50: text,
      }),
      speedStagesKmh: z.tuple([text, text, text]),
      yellowTemporarySigns: z.boolean(),
      location: z.enum(['auto', 'in', 'out']),
      speedConditions: speedConditionsSchema.optional(),
      signSize: z.enum(['auto', 'I', 'II', 'III', 'IV']),
      approachSpeedKmh: text,
      lastSettlement: z.boolean().nullable(),
      frontStyle: z.enum(['part', 'solid']),
      frontFromPu66: z.boolean(),
      regulation: z.strictObject({
        mode: z.enum(['auto', 'signs', 'one', 'two']),
        hourly: text,
        k: z.number().finite(),
        vis: z.boolean(),
        straight: z.boolean(),
        last: text.nullable(),
      }),
      workZones: z.strictObject({ b33: zone.nullable(), b34: zone.nullable() }),
      workConditions: z
        .strictObject({
          kind: z.enum(['unknown', 'short', 'long']),
          durationHours: text,
          daylight: z.enum(['unknown', 'day', 'night']),
          regulatorsPresent: z.boolean(),
          sectionMetres: text,
        })
        .default({
          kind: 'unknown',
          durationHours: '',
          daylight: 'unknown',
          regulatorsPresent: false,
          sectionMetres: '',
        }),
    }),
  ),
  // Копии восстановления до 30.09.2026 хранят реквизиты v5 — они переводятся в v6 при чтении.
  // Телефон в неприменённом вводе может быть набран не полностью.
  titleBlock: z.preprocess(
    (value) => {
      const legacy = titleBlockV5DraftSchema.safeParse(value)
      return legacy.success ? upgradeTitleBlock(legacy.data) : value
    },
    z.strictObject({
      developer: z.strictObject({ organization: text, position: text, name: text, date: text }),
      work: z.strictObject({ organization: text, description: text, period: text }),
      responsible: z
        .array(z.strictObject({ position: text, name: text, phone: text }))
        .min(1)
        .max(2),
      approver: z.strictObject({ position: text, organization: text, name: text }),
      agreement: z.strictObject({ position: text, name: text, year: text }),
    }),
  ),
})

const baseDraft = {
  id: z.number().int().positive().nullable(),
  anchor: z.enum(['abs', 'L0', 'L1', 'Z0', 'Z1', 'E', 'AX']),
  x: text,
  y: text,
}
export const placementDraftSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    ...baseDraft,
    kind: z.literal('sign-post'),
    side: z.enum(['up', 'down']),
    stand: z.enum(['left', 'right']),
    signCodes: text,
    distanceLabel: text,
  }),
  z.strictObject({
    ...baseDraft,
    kind: z.literal('element'),
    elementKind: z.enum(['reg', 'cone', 'car', 'complex', 'pit', 'text']),
    width: text,
    height: text,
    text,
    fontSize: text,
    bold: z.boolean(),
  }),
])

export const recoveryWriteSchema = z.strictObject({
  sessionId: z.uuid(),
  scheme: schemeSchema,
  baseRevision: z.number().int().nonnegative().nullable(),
  detailsDraft: detailsDraftSchema.nullable(),
  placementDraft: placementDraftSchema.nullable(),
  fileName: z.string().max(256),
  expectedVersion: z.number().int().nonnegative(),
})

export const recoveryRecordSchema = recoveryWriteSchema.omit({ expectedVersion: true }).extend({
  version: z.number().int().positive(),
  updatedAt: z.iso.datetime(),
})
export const recoverySummarySchema = recoveryRecordSchema
  .omit({ scheme: true, detailsDraft: true, placementDraft: true })
  .extend({ referenceId: z.string(), active: z.boolean() })
export const recoveryDeleteSchema = z.strictObject({ expectedVersion: z.number().int().positive() })

export type RecoveryWrite = z.infer<typeof recoveryWriteSchema>
export type RecoveryRecord = z.infer<typeof recoveryRecordSchema>
export type RecoverySummary = z.infer<typeof recoverySummarySchema>
