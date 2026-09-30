import { z } from 'zod'
import { pu66SnapshotSchema } from './pu66-snapshot.ts'

const finite = z.number().finite()
const text = z.string().max(5_000)
export const anchorSchema = z.enum(['abs', 'L0', 'L1', 'Z0', 'Z1', 'E', 'AX'])
const anchor = anchorSchema

const workZoneSchema = z.strictObject({
  taperMetres: finite.positive(),
  bufferMetres: finite.positive(),
  workMetres: finite.positive(),
  labels: z.strictObject({ taper: text, buffer: text, work: text }),
})

const crossingV2Schema = z.strictObject({
  referenceId: z.string().min(1).max(120),
  source: z.literal('legacy-pu66'),
  snapshot: z.null(),
})
const crossingV3Schema = z.strictObject({
  referenceId: z.string().min(1).max(120),
  source: z.enum(['legacy-pu66', 'entered-by-editor']),
  snapshot: z.null(),
})
const crossingSchema = z.discriminatedUnion('source', [
  z.strictObject({
    referenceId: z.string().min(1).max(120),
    source: z.literal('legacy-pu66'),
    snapshot: z.null(),
  }),
  z.strictObject({
    referenceId: z.string().min(1).max(120),
    source: z.literal('entered-by-editor'),
    snapshot: z.null(),
  }),
  z.strictObject({
    referenceId: z.string().min(1).max(120),
    source: z.literal('local-pu66'),
    snapshot: pu66SnapshotSchema,
  }),
])

const templateSchema = z.strictObject({
  code: z.enum(['b33', 'b34']),
  sourceReference: z.literal('ОДМ 218.6.019-2016'),
  reviewStatus: z.literal('not-verified'),
})
/** Версия условной раскладки шаблона: draft-2 — состав стоек по рисункам Б.33/Б.34. */
const templateV5Schema = templateSchema.extend({
  projectionVersion: z.enum(['draft-1', 'draft-2']),
})

const position = z.strictObject({ anchor, offsetXSvg: finite })

/** Место объекта в черновом шаблоне: сохраняется при ручной правке, чтобы пересборка не дублировала его. */
const templateSlot = z
  .string()
  .regex(/^[A-Za-z0-9:._-]{1,40}$/)
  .optional()

const signPlacementSchema = z.strictObject({
  kind: z.literal('sign-post'),
  id: z.number().int().positive(),
  generatedByTemplate: z.boolean(),
  templateSlot,
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
  templateSlot,
  elementKind: z.enum(['reg', 'cone', 'car', 'complex', 'pit', 'text']),
  position: position.extend({ ySvg: finite }),
  sizeSvg: z.strictObject({ width: finite.nonnegative(), height: finite.nonnegative() }),
  text: text.nullable(),
  fontSizeSvg: finite.positive().nullable(),
  bold: z.boolean(),
})

const elementPlacementV5Schema = elementPlacementSchema.extend({
  position: position.extend({ ySvg: finite, zoneFraction: finite.optional() }),
})

const titleBlockSchema = z.strictObject({
  developer: z.strictObject({ organization: text, name: text, date: text }),
  work: z.strictObject({ organization: text, description: text, period: text }),
  responsible: z.tuple([text, text]),
  approver: z.strictObject({ position: text, organization: text, name: text }),
  agreement: z.strictObject({ position: text, name: text, year: text }),
})

const parameterFields = {
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
}

const signDistancesV5Schema = parameterFields.signDistancesMetres.extend({
  n100: finite.nonnegative().nullable(),
  n50: finite.nonnegative().nullable(),
})

const regulationSchema = z.strictObject({
  mode: z.enum(['auto', 'signs', 'one', 'two']),
  hourly: text,
  k: finite,
  vis: z.boolean(),
  straight: z.boolean(),
  last: text.nullable(),
})

export const defaultLegacyParameters = {
  location: 'auto' as const,
  signSize: 'auto' as const,
  settlementSpeedKmh: 60,
  lastSettlement: null,
  frontStyle: 'part' as const,
  frontFromPu66: false,
  regulation: {
    mode: 'auto' as const,
    hourly: '',
    k: 0,
    vis: false,
    straight: false,
    last: null,
  },
}

const legacySourceSchema = z.strictObject({
  kind: z.literal('legacy-html-v1'),
  importedAt: z.iso.datetime(),
  originalJson: z
    .string()
    .min(1)
    .max(10 * 1024 * 1024),
})

const sharedFields = {
  id: z.uuid(),
  createdAt: z.iso.datetime(),
  template: templateSchema,
  titleBlock: titleBlockSchema,
  placements: z
    .array(z.discriminatedUnion('kind', [signPlacementSchema, elementPlacementSchema]))
    .max(2_000),
  nextPlacementId: z.number().int().positive(),
}

function checkPlacements(
  scheme: { placements: z.infer<typeof sharedFields.placements>; nextPlacementId: number },
  context: z.RefinementCtx,
): void {
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
}

function checkModernScheme(
  scheme: {
    placements: z.infer<typeof sharedFields.placements>
    nextPlacementId: number
    parameters: { workZones: { b33: WorkZone | null; b34: WorkZone | null } }
    template: { code: 'b33' | 'b34' }
    source: { kind: string }
  },
  context: z.RefinementCtx,
): void {
  checkPlacements(scheme, context)
  const activeZone = scheme.parameters.workZones[scheme.template.code]
  if (activeZone === null) {
    context.addIssue({
      code: 'custom',
      path: ['parameters', 'workZones', scheme.template.code],
      message: 'Для выбранного варианта нужны размеры зоны работ',
    })
  } else if (
    scheme.source.kind === 'created-in-editor' &&
    (activeZone.workMetres < 30 ? 'b34' : 'b33') !== scheme.template.code
  ) {
    context.addIssue({
      code: 'custom',
      path: ['parameters', 'workZones', scheme.template.code, 'workMetres'],
      message: 'Длина фронта не соответствует выбранному варианту Б.33/Б.34',
    })
  }
}

/** Read-only validator for files and SQLite revisions produced before native project creation. */
export const schemeV2Schema = z
  .strictObject({
    ...sharedFields,
    schemaVersion: z.literal(2),
    crossing: crossingV2Schema,
    parameters: z.strictObject({
      ...parameterFields,
      workZones: z.strictObject({ b33: workZoneSchema, b34: workZoneSchema }),
    }),
    source: legacySourceSchema,
  })
  .superRefine(checkPlacements)

export const schemeV3Schema = z
  .strictObject({
    ...sharedFields,
    schemaVersion: z.literal(3),
    crossing: crossingV3Schema,
    parameters: z.strictObject({
      ...parameterFields,
      workZones: z.strictObject({
        b33: workZoneSchema.nullable(),
        b34: workZoneSchema.nullable(),
      }),
    }),
    source: z.union([legacySourceSchema, z.strictObject({ kind: z.literal('created-in-editor') })]),
  })
  .superRefine(checkModernScheme)

export const schemeV4Schema = z
  .strictObject({
    ...sharedFields,
    schemaVersion: z.literal(4),
    crossing: crossingSchema,
    parameters: z.strictObject({
      ...parameterFields,
      workZones: z.strictObject({
        b33: workZoneSchema.nullable(),
        b34: workZoneSchema.nullable(),
      }),
    }),
    source: z.union([legacySourceSchema, z.strictObject({ kind: z.literal('created-in-editor') })]),
  })
  .superRefine(checkModernScheme)

export const schemeSchema = z
  .strictObject({
    ...sharedFields,
    template: templateV5Schema,
    signImages: z
      .strictObject({
        catalog: z
          .strictObject({ documentCode: text, edition: text, id: z.number().int().positive() })
          .nullable(),
        revisions: z.record(z.string().min(1).max(120), z.number().int().positive()),
      })
      .default(() => ({ catalog: null, revisions: {} })),
    placements: z
      .array(z.discriminatedUnion('kind', [signPlacementSchema, elementPlacementV5Schema]))
      .max(2_000),
    schemaVersion: z.literal(5),
    crossing: crossingSchema,
    parameters: z.strictObject({
      ...parameterFields,
      signDistancesMetres: signDistancesV5Schema,
      location: z.enum(['auto', 'in', 'out']),
      signSize: z.enum(['auto', 'I', 'II', 'III', 'IV']),
      settlementSpeedKmh: finite.positive(),
      lastSettlement: z.boolean().nullable(),
      frontStyle: z.enum(['part', 'solid']),
      frontFromPu66: z.boolean(),
      regulation: regulationSchema,
      workZones: z.strictObject({
        b33: workZoneSchema.nullable(),
        b34: workZoneSchema.nullable(),
      }),
    }),
    source: z.union([legacySourceSchema, z.strictObject({ kind: z.literal('created-in-editor') })]),
  })
  .superRefine(checkModernScheme)

export type Scheme = z.infer<typeof schemeSchema>
export type SchemeV2 = z.infer<typeof schemeV2Schema>
export type SchemeV3 = z.infer<typeof schemeV3Schema>
export type SchemeV4 = z.infer<typeof schemeV4Schema>
export type Crossing = z.infer<typeof crossingSchema>
export type Template = z.infer<typeof templateSchema>
export type SignPlacement = z.infer<typeof signPlacementSchema>
export type WorkZone = z.infer<typeof workZoneSchema>

export function upgradeSchemeV2(value: unknown): Scheme {
  const previous = schemeV2Schema.parse(value)
  return upgradeSchemeV4({ ...previous, schemaVersion: 4 })
}

export function upgradeSchemeV3(value: unknown): Scheme {
  const previous = schemeV3Schema.parse(value)
  return upgradeSchemeV4({ ...previous, schemaVersion: 4 })
}

export function upgradeSchemeV4(value: unknown): Scheme {
  const previous = schemeV4Schema.parse(value)
  return schemeSchema.parse({
    ...previous,
    schemaVersion: 5,
    template: { ...previous.template, projectionVersion: 'draft-1' },
    signImages: { catalog: null, revisions: {} },
    parameters: {
      ...previous.parameters,
      signDistancesMetres: { ...previous.parameters.signDistancesMetres, n100: null, n50: null },
      ...defaultLegacyParameters,
    },
  })
}

export function parseStoredScheme(value: unknown): Scheme {
  if (value && typeof value === 'object' && 'schemaVersion' in value && value.schemaVersion === 2) {
    return upgradeSchemeV2(value)
  }
  if (value && typeof value === 'object' && 'schemaVersion' in value && value.schemaVersion === 3) {
    return upgradeSchemeV3(value)
  }
  if (value && typeof value === 'object' && 'schemaVersion' in value && value.schemaVersion === 4) {
    return upgradeSchemeV4(value)
  }
  return schemeSchema.parse(value)
}
