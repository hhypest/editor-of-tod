import { z } from 'zod'

const text = z.string().max(5_000)
const value = z.union([
  z.number().finite(),
  z.record(z.string().max(240), z.string().max(2_000)),
  z.null(),
])
export const documentBasisSchema = z.strictObject({
  id: z.number().int().positive(),
  label: z.string().max(240),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  effectiveFrom: z.union([z.iso.date(), z.literal('')]).optional(),
})
export const parameterBasisSchema = z.strictObject({
  id: z.string().min(1).max(120),
  title: text,
  source: text,
  value,
  confirmed: z.boolean(),
  document: documentBasisSchema.nullable(),
  currentDocument: documentBasisSchema.nullable(),
  amendments: z.array(documentBasisSchema).max(100),
  confirmation: z
    .strictObject({
      id: z.number().int().positive(),
      documentLabel: z.string().max(240),
      clause: z.string().max(240),
      confirmedAt: z.string().max(80),
    })
    .nullable(),
  fingerprint: z.string().min(1).max(128),
})
export const speedConditionsSchema = z.strictObject({
  road: z.enum(['', 'ordinary', 'motorway', 'residential']),
  vehicle: z.enum([
    '',
    'light',
    'heavy',
    'busSeated',
    'busOther',
    'children',
    'peopleTruck',
    'towing',
    'permit',
  ]),
})
const fields = {
  recordedAt: z.iso.datetime(),
  note: text.min(2),
  inputFingerprint: z.string().min(1).max(128),
  parameters: z.array(parameterBasisSchema).max(30),
}
export const decisionEvidenceSchema = z.strictObject({
  speed: z
    .strictObject({
      ...fields,
      conditions: speedConditionsSchema,
      location: z.enum(['auto', 'in', 'out']),
      approachSpeedKmh: z.number().finite().positive().nullable(),
      speedStagesKmh: z.tuple([
        z.number().finite().positive(),
        z.number().finite().positive(),
        z.number().finite().positive(),
      ]),
      referenceSpeedKmh: z.number().finite().positive().nullable(),
    })
    .nullable(),
  regulation: z
    .strictObject({
      ...fields,
      input: z.strictObject({
        variant: z.enum(['b33', 'b34']),
        crossingReferenceId: z.string().min(1).max(120),
        crossingRevision: z.number().int().positive().nullable(),
        hourly: text,
        limitedVisibility: z.boolean(),
        straight: z.boolean(),
        zoneSpeedKmh: z.number().finite().positive(),
        taperMetres: z.number().finite().positive().nullable(),
        bufferMetres: z.number().finite().positive().nullable(),
        frontMetres: z.number().finite().positive().nullable(),
        sectionMetres: z.number().finite().positive().nullable(),
        workConditions: z.strictObject({
          kind: z.enum(['unknown', 'short', 'long']),
          durationHours: z.number().finite().positive().nullable(),
          daylight: z.enum(['unknown', 'day', 'night']),
          regulatorsPresent: z.boolean(),
          sectionMetres: z.number().finite().positive().nullable(),
        }),
      }),
      mode: z.enum(['signs', 'one', 'two']),
      recommendation: z.enum(['signs', 'one', 'two']).nullable(),
      reasons: z.array(text).max(30),
      warnings: z.array(text).max(30),
    })
    .nullable(),
})
export type ParameterBasis = z.infer<typeof parameterBasisSchema>
export type DecisionEvidence = z.infer<typeof decisionEvidenceSchema>
export type SpeedConditions = z.infer<typeof speedConditionsSchema>
