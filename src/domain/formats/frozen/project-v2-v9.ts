/* Frozen project readers v2–v9, copied from a74e084 (#137).
 * Only historical schemas live here; migrations and current validators stay in model.ts.
 */
import { z } from 'zod'
import { pu66SnapshotSchema } from './pu66-snapshot-v4.ts'
import { decisionEvidenceSchema, speedConditionsSchema } from './decision-evidence-v9.ts'

const PHONE_PATTERN = /^\+7 \(\d{3}\) \d{3}-\d{2}-\d{2}$/
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

/** Реквизиты листа v1–v5: ответственные — две строки текста. */
const titleBlockV5Schema = z.strictObject({
  developer: z.strictObject({ organization: text, name: text, date: text }),
  work: z.strictObject({ organization: text, description: text, period: text }),
  responsible: z.tuple([text, text]),
  approver: z.strictObject({ position: text, organization: text, name: text }),
  agreement: z.strictObject({ position: text, name: text, year: text }),
})

/** Телефон ответственного по маске +7 (XXX) XXX-XX-XX или пусто, пока не введён. */
export const phoneSchema = z.union([z.literal(''), z.string().regex(PHONE_PATTERN)])
export const responsiblePersonSchema = z.strictObject({
  position: text,
  name: text,
  phone: phoneSchema,
})

/**
 * Реквизиты листа v6: должность разработчика; ответственные отдельными полями — первый
 * обязателен, второй по желанию. Подписи на листе рисуются строкой «______ ФИО».
 */
export const titleBlockSchema = z.strictObject({
  developer: z.strictObject({ organization: text, position: text, name: text, date: text }),
  work: z.strictObject({ organization: text, description: text, period: text }),
  responsible: z.array(responsiblePersonSchema).min(1).max(2),
  approver: z.strictObject({ position: text, organization: text, name: text }),
  agreement: z.strictObject({ position: text, name: text, year: text }),
})

/**
 * Отметки ручной проверки: пункт «Проверить вручную» → отпечаток его содержания на момент
 * отметки. Если содержание пункта изменилось, отметка перестаёт действовать.
 */
export const reviewMarksSchema = z
  .record(
    z.string().min(1).max(80),
    z.strictObject({ fingerprint: z.string().min(1).max(128), markedAt: z.iso.datetime() }),
  )
  .refine((marks) => Object.keys(marks).length <= 100, 'Слишком много отметок проверки')

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
  titleBlock: titleBlockV5Schema,
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
  }
  // Соответствие фронта и варианта — правило проекта с настраиваемым порогом, а не
  // инвариант хранения: проект, сохранённый при прежнем пороге, должен открываться.
  // Расхождение показывает проверка листа (пункт «Вариант и длина фронта»).
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

const schemeV5Fields = {
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
}

/** Read-only validator for files and SQLite revisions saved before 30.09.2026 (format v5). */
export const schemeV5Schema = z
  .strictObject({ ...schemeV5Fields, schemaVersion: z.literal(5) })
  .superRefine(checkModernScheme)

const schemeV6Fields = {
  ...schemeV5Fields,
  titleBlock: titleBlockSchema,
  reviewMarks: reviewMarksSchema.default(() => ({})),
}

/** Read-only validator for files and SQLite revisions saved before 01.10.2026 (format v6). */
export const schemeV6Schema = z
  .strictObject({ ...schemeV6Fields, schemaVersion: z.literal(6) })
  .superRefine(checkModernScheme)

const { settlementSpeedKmh: _settlementSpeed, ...parametersV7Fields } =
  schemeV5Fields.parameters.shape
void _settlementSpeed

/**
 * Прежний формат проекта v7: вместо «скорости в населённом пункте» — разрешённая скорость на
 * подходе к месту работ для обоих вариантов местоположения. От неё считаются ступени 3.24 по
 * умолчанию; null — скорость не указана (проекты вне населённого пункта до v7).
 */
export const schemeV7Schema = z
  .strictObject({
    ...schemeV6Fields,
    schemaVersion: z.literal(7),
    parameters: z.strictObject({
      ...parametersV7Fields,
      approachSpeedKmh: finite.positive().nullable(),
    }),
  })
  .superRefine(checkModernScheme)

export const workConditionsSchema = z.strictObject({
  kind: z.enum(['unknown', 'short', 'long']).default('unknown'),
  durationHours: finite.positive().nullable().default(null),
  daylight: z.enum(['unknown', 'day', 'night']).default('unknown'),
  regulatorsPresent: z.boolean().default(false),
  sectionMetres: finite.positive().nullable().default(null),
})
/** v8 adds explicit work conditions; missing historical conditions remain unknown. */
export const schemeV8Schema = z
  .strictObject({
    ...schemeV7Schema.shape,
    schemaVersion: z.literal(8),
    parameters: schemeV7Schema.shape.parameters.extend({
      workConditions: workConditionsSchema.default({
        kind: 'unknown',
        durationHours: null,
        daylight: 'unknown',
        regulatorsPresent: false,
        sectionMetres: null,
      }),
    }),
  })
  .superRefine(checkModernScheme)

/** v9 records explicit speed conditions and historical decision evidence without inventing it. */
const schemeV9Object = z.strictObject({
  ...schemeV8Schema.shape,
  schemaVersion: z.literal(9),
  parameters: schemeV8Schema.shape.parameters.extend({
    speedConditions: speedConditionsSchema.default({ road: '', vehicle: '' }),
  }),
  decisionEvidence: decisionEvidenceSchema.default({ speed: null, regulation: null }),
})

function checkSpeedConditions(
  scheme: { parameters: { speedConditions: { road: string } } },
  context: z.RefinementCtx,
): void {
  if (scheme.parameters.speedConditions.road === 'motorway')
    context.addIssue({
      code: 'custom',
      path: ['parameters', 'speedConditions', 'road'],
      message:
        'Автомагистраль доступна только для справки; для схемы переезда выберите другое условие.',
    })
}

/** Read-only validator for files and SQLite revisions saved before Р1 (format v9). */
export const schemeV9Schema = schemeV9Object
  .superRefine(checkModernScheme)
  .superRefine(checkSpeedConditions)

export type HistoricalTitleBlock = z.infer<typeof titleBlockV5Schema>
type WorkZone = z.infer<typeof workZoneSchema>
