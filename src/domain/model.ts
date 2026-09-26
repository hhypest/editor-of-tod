import { z } from 'zod'

const finite = z.number().finite()
const text = z.string().max(5_000)
const anchor = z.enum(['abs', 'L0', 'L1', 'Z0', 'Z1', 'E', 'AX'])

const workZoneSchema = z.strictObject({
  taperMetres: finite.positive(),
  bufferMetres: finite.positive(),
  workMetres: finite.positive(),
  labels: z.strictObject({ taper: text, buffer: text, work: text }),
})

const crossingSchema = z.strictObject({
  referenceId: z.string().min(1).max(120),
  source: z.literal('legacy-pu66'),
  snapshot: z.null(),
})

const templateSchema = z.strictObject({
  code: z.enum(['b33', 'b34']),
  sourceReference: z.literal('ОДМ 218.6.019-2016'),
  reviewStatus: z.literal('not-verified'),
})

const position = z.strictObject({ anchor, offsetXSvg: finite })

const signPlacementSchema = z.strictObject({
  kind: z.literal('sign-post'),
  id: z.number().int().positive(),
  generatedByTemplate: z.boolean(),
  position: position.extend({ offsetYSvg: finite }),
  side: z.enum(['up', 'down']),
  stand: z.enum(['left', 'right']),
  signIds: z.array(z.string().min(1).max(120)).min(1).max(20),
  distanceLabel: text.nullable(),
})

const elementPlacementSchema = z.strictObject({
  kind: z.literal('element'),
  id: z.number().int().positive(),
  generatedByTemplate: z.boolean(),
  elementKind: z.enum(['reg', 'cone', 'car', 'complex', 'pit', 'text']),
  position: position.extend({ ySvg: finite }),
  sizeSvg: z.strictObject({ width: finite.nonnegative(), height: finite.nonnegative() }),
  text: text.nullable(),
  fontSizeSvg: finite.positive().nullable(),
  bold: z.boolean(),
})

const titleBlockSchema = z.strictObject({
  developer: z.strictObject({ organization: text, name: text, date: text }),
  work: z.strictObject({ organization: text, description: text, period: text }),
  responsible: z.tuple([text, text]),
  approver: z.strictObject({ position: text, organization: text, name: text }),
  agreement: z.strictObject({ position: text, name: text, year: text }),
})

export const schemeSchema = z
  .strictObject({
    schemaVersion: z.literal(2),
    id: z.uuid(),
    createdAt: z.iso.datetime(),
    crossing: crossingSchema,
    template: templateSchema,
    parameters: z.strictObject({
      locationText: text,
      directions: z.strictObject({ left: text, right: text }),
      signDistancesMetres: z.strictObject({
        d300: finite.nonnegative().nullable(),
        d250: finite.nonnegative().nullable(),
        d150: finite.nonnegative().nullable(),
        d50: finite.nonnegative().nullable(),
      }),
      speedStagesKmh: z.tuple([finite.positive(), finite.positive(), finite.positive()]),
      yellowTemporarySigns: z.boolean(),
      workZones: z.strictObject({ b33: workZoneSchema, b34: workZoneSchema }),
    }),
    titleBlock: titleBlockSchema,
    placements: z
      .array(z.discriminatedUnion('kind', [signPlacementSchema, elementPlacementSchema]))
      .max(2_000),
    nextPlacementId: z.number().int().positive(),
    source: z.strictObject({
      kind: z.literal('legacy-html-v1'),
      importedAt: z.iso.datetime(),
      originalJson: z
        .string()
        .min(1)
        .max(10 * 1024 * 1024),
    }),
  })
  .superRefine((scheme, context) => {
    const ids = new Set<number>()
    let highestId = 0
    for (const [index, placement] of scheme.placements.entries()) {
      if (ids.has(placement.id)) {
        context.addIssue({
          code: 'custom',
          path: ['placements', index, 'id'],
          message: 'Повторяющийся идентификатор объекта',
        })
      }
      ids.add(placement.id)
      highestId = Math.max(highestId, placement.id)
    }
    if (scheme.nextPlacementId <= highestId) {
      context.addIssue({
        code: 'custom',
        path: ['nextPlacementId'],
        message: 'Номер следующего объекта уже занят',
      })
    }
  })

export type Scheme = z.infer<typeof schemeSchema>
export type Crossing = z.infer<typeof crossingSchema>
export type Template = z.infer<typeof templateSchema>
export type SignPlacement = z.infer<typeof signPlacementSchema>
export type WorkZone = z.infer<typeof workZoneSchema>
