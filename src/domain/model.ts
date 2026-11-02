import { schemeV12Schema } from './formats/frozen/project-v12.ts'
export { schemeV12Schema } from './formats/frozen/project-v12.ts'
import { schemeV10Schema } from './formats/frozen/project-v10.ts'
export { schemeV10Schema } from './formats/frozen/project-v10.ts'
import { schemeV11Schema } from './formats/frozen/project-v11.ts'
export { schemeV11Schema } from './formats/frozen/project-v11.ts'
import { roadLayoutSchema, checkRoadLayoutPlacements } from './road-layout.ts'
import { migrateRoadLayout } from './migrate-road-layout.ts'
import {
  schemeV2Schema,
  schemeV3Schema,
  schemeV4Schema,
  schemeV5Schema,
  schemeV6Schema,
  schemeV7Schema,
  schemeV8Schema,
  schemeV9Schema,
  type HistoricalTitleBlock,
} from './formats/frozen/project-v2-v9.ts'
export {
  schemeV2Schema,
  schemeV3Schema,
  schemeV4Schema,
  schemeV5Schema,
  schemeV6Schema,
  schemeV7Schema,
  schemeV8Schema,
  schemeV9Schema,
} from './formats/frozen/project-v2-v9.ts'
import { z } from 'zod'
import { PHONE_PATTERN, responsibleFromLegacy } from './title-block.ts'
import { pu66SnapshotSchema } from './pu66-snapshot.ts'
import { decisionEvidenceSchema, speedConditionsSchema } from './decision-evidence-schema.ts'
import { adoptPostDistances, DISTANCE_MARKERS } from './post-distance.ts'
import { legacySpeedInputFingerprint, speedInputFingerprint } from './speed-evidence-input.ts'

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

/** Поля расстояний этапа 2, с которыми может быть связана стойка. */
export const distanceMarkerSchema = z.enum(DISTANCE_MARKERS)
/** Подход к месту работ: слева (движение по нижней полосе) или справа (по верхней). */
export const approachSchema = z.enum(['left', 'right'])

/**
 * Расстояние стойки до начала работ для своего подхода, м (v10, ADR-0008). `marker` — стойка
 * следует за полем расстояния этапа 2; `metres` — собственное число. Положение на листе и
 * подпись на выноске выводятся из расстояния; `null` — стойка без расстояния, её положение
 * задано условной координатой.
 */
export const postDistanceSchema = z.discriminatedUnion('by', [
  z.strictObject({
    by: z.literal('marker'),
    approach: approachSchema,
    marker: distanceMarkerSchema,
  }),
  z.strictObject({
    by: z.literal('metres'),
    approach: approachSchema,
    metres: finite.nonnegative().max(10_000),
  }),
])

const signPlacementV10Schema = signPlacementSchema.extend({
  distance: postDistanceSchema.nullable(),
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
  }
  // Соответствие фронта и варианта — правило проекта с настраиваемым порогом, а не
  // инвариант хранения: проект, сохранённый при прежнем пороге, должен открываться.
  // Расхождение показывает проверка листа (пункт «Вариант и длина фронта»).
}

export const workConditionsSchema = z.strictObject({
  kind: z.enum(['unknown', 'short', 'long']).default('unknown'),
  durationHours: finite.positive().nullable().default(null),
  daylight: z.enum(['unknown', 'day', 'night']).default('unknown'),
  regulatorsPresent: z.boolean().default(false),
  sectionMetres: finite.positive().nullable().default(null),
})

// Field order is part of serialized fingerprints; keep the v10 order.
const currentFields = {
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
    lastSettlement: z.boolean().nullable(),
    frontStyle: z.enum(['part', 'solid']),
    frontFromPu66: z.boolean(),
    regulation: regulationSchema,
    workZones: z.strictObject({ b33: workZoneSchema.nullable(), b34: workZoneSchema.nullable() }),
    approachSpeedKmh: finite.positive().nullable(),
    workConditions: workConditionsSchema.default({
      kind: 'unknown',
      durationHours: null,
      daylight: 'unknown',
      regulatorsPresent: false,
      sectionMetres: null,
    }),
    speedConditions: speedConditionsSchema.default({ road: '', vehicle: '' }),
  }),
  source: z.union([legacySourceSchema, z.strictObject({ kind: z.literal('created-in-editor') })]),
}

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

/**
 * v13 (#107): optional explicit branch placement on road-object links. Existing project
 * fields retain their order and values; migration infers no geometry or automatic placement.
 */
export const schemeSchema = z
  .strictObject({
    ...currentFields,
    titleBlock: titleBlockSchema,
    reviewMarks: reviewMarksSchema.default(() => ({})),
    schemaVersion: z.literal(13),
    decisionEvidence: decisionEvidenceSchema.default({ speed: null, regulation: null }),
    placements: z
      .array(z.discriminatedUnion('kind', [signPlacementV10Schema, elementPlacementV5Schema]))
      .max(2_000),
    roadLayout: roadLayoutSchema,
  })
  .superRefine(checkModernScheme)
  .superRefine(checkSpeedConditions)
  .superRefine(checkRoadLayoutPlacements)
  .superRefine((scheme, context) => {
    for (const [index, placement] of scheme.placements.entries())
      if (placement.kind === 'sign-post' && placement.distance && placement.distanceLabel !== null)
        context.addIssue({
          code: 'custom',
          path: ['placements', index, 'distanceLabel'],
          message: 'У стойки с расстоянием подпись строится из расстояния',
        })
  })

export type Scheme = z.infer<typeof schemeSchema>
export type SchemeV2 = z.infer<typeof schemeV2Schema>
export type SchemeV3 = z.infer<typeof schemeV3Schema>
export type SchemeV4 = z.infer<typeof schemeV4Schema>
export type SchemeV5 = z.infer<typeof schemeV5Schema>
export type SchemeV6 = z.infer<typeof schemeV6Schema>
export type SchemeV9 = z.infer<typeof schemeV9Schema>
export type { Approach, DistanceMarker, PostDistance } from './post-distance.ts'
export type TitleBlock = z.infer<typeof titleBlockSchema>
export type Crossing = z.infer<typeof crossingSchema>
export type Template = z.infer<typeof templateSchema>
export type SignPlacement = z.infer<typeof signPlacementV10Schema>
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
  return upgradeSchemeV5({
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

/** Реквизиты v1–v5 → v6: строки ответственных разбираются на должность, ФИО и телефон. */
export function upgradeTitleBlock(previous: HistoricalTitleBlock): TitleBlock {
  return {
    developer: { ...previous.developer, position: '' },
    work: { ...previous.work },
    responsible: responsibleFromLegacy(previous.responsible[0], previous.responsible[1]),
    approver: { ...previous.approver },
    agreement: { ...previous.agreement },
  }
}

export function upgradeSchemeV5(value: unknown): Scheme {
  const previous = schemeV5Schema.parse(value)
  return upgradeSchemeV6({
    ...previous,
    schemaVersion: 6,
    titleBlock: upgradeTitleBlock(previous.titleBlock),
    reviewMarks: {},
  })
}

/**
 * v6 → v7. До v7 скорость на подходе вводилась только для населённого пункта; вне его поле
 * не использовалось, поэтому значение не переносится, а составитель укажет скорость сам.
 * Для «не определено» переносится прежнее значение — его вводили как скорость в населённом
 * пункте.
 */
export function upgradeSchemeV6(value: unknown): Scheme {
  const previous = schemeV6Schema.parse(value)
  const { settlementSpeedKmh, ...parameters } = previous.parameters
  return upgradeSchemeV7({
    ...previous,
    schemaVersion: 7,
    parameters: {
      ...parameters,
      approachSpeedKmh: parameters.location === 'out' ? null : settlementSpeedKmh,
    },
  })
}

export function upgradeSchemeV7(value: unknown): Scheme {
  const previous = schemeV7Schema.parse(value)
  return upgradeSchemeV8({ ...previous, schemaVersion: 8 })
}

export function upgradeSchemeV8(value: unknown): Scheme {
  const previous = schemeV8Schema.parse(value)
  return upgradeSchemeV9({ ...previous, schemaVersion: 9 })
}

/**
 * v9 → v10: стойка получает расстояние из прежней подписи, если это не меняет её места на
 * листе (`adoptPostDistances`); остальные стойки сохраняют условные координаты и подпись.
 */
export function upgradeSchemeV9(value: unknown): Scheme {
  const previous = schemeV9Schema.parse(value)
  const placements = adoptPostDistances(previous)
  return upgradeSchemeV10({
    ...previous,
    schemaVersion: 10,
    placements,
    decisionEvidence: carrySpeedEvidence(previous, placements),
  })
}

/**
 * Запись основания скорости v9 считала отпечаток по стойкам v9. Если он совпадает со стойками
 * файла, исходные данные с момента записи не менялись — отпечаток пересчитывается по
 * обновлённым стойкам, и запись остаётся действующей. Иначе запись переносится как есть и
 * остаётся устаревшей (замечание Codex к PR #150).
 */
function carrySpeedEvidence(
  previous: z.infer<typeof schemeV9Schema>,
  placements: Parameters<typeof speedInputFingerprint>[0]['placements'],
): z.infer<typeof schemeV9Schema>['decisionEvidence'] {
  const speed = previous.decisionEvidence.speed
  if (!speed || speed.inputFingerprint !== legacySpeedInputFingerprint(previous))
    return previous.decisionEvidence
  return {
    ...previous.decisionEvidence,
    speed: {
      ...speed,
      inputFingerprint: speedInputFingerprint({ parameters: previous.parameters, placements }),
    },
  }
}

/** v10 → v11 adds no values to a historical snapshot. New data requires explicit relinking. */
export function upgradeSchemeV10(value: unknown): Scheme {
  const previous = schemeV10Schema.parse(value)
  return upgradeSchemeV11({ ...previous, schemaVersion: 11 })
}

/** v11 → v12: only explicit source distances/links; objects and historical snapshots stay intact. */
export function upgradeSchemeV11(value: unknown): Scheme {
  const previous = schemeV11Schema.parse(value)
  return upgradeSchemeV12({
    ...previous,
    schemaVersion: 12,
    roadLayout: migrateRoadLayout(previous.source, previous.placements),
  })
}

/** v12 → v13 introduces no inferred branch placement or post movement. */
export function upgradeSchemeV12(value: unknown): Scheme {
  const previous = schemeV12Schema.parse(value)
  return schemeSchema.parse({ ...previous, schemaVersion: 13 })
}

export function parseStoredScheme(value: unknown): Scheme {
  if (value && typeof value === 'object' && 'schemaVersion' in value && value.schemaVersion === 12)
    return upgradeSchemeV12(value)
  if (value && typeof value === 'object' && 'schemaVersion' in value && value.schemaVersion === 2) {
    return upgradeSchemeV2(value)
  }
  if (value && typeof value === 'object' && 'schemaVersion' in value && value.schemaVersion === 3) {
    return upgradeSchemeV3(value)
  }
  if (value && typeof value === 'object' && 'schemaVersion' in value && value.schemaVersion === 4) {
    return upgradeSchemeV4(value)
  }
  if (value && typeof value === 'object' && 'schemaVersion' in value && value.schemaVersion === 5) {
    return upgradeSchemeV5(value)
  }
  if (value && typeof value === 'object' && 'schemaVersion' in value && value.schemaVersion === 6) {
    return upgradeSchemeV6(value)
  }
  if (value && typeof value === 'object' && 'schemaVersion' in value && value.schemaVersion === 7)
    return upgradeSchemeV7(value)
  if (value && typeof value === 'object' && 'schemaVersion' in value && value.schemaVersion === 8)
    return upgradeSchemeV8(value)
  if (value && typeof value === 'object' && 'schemaVersion' in value && value.schemaVersion === 9)
    return upgradeSchemeV9(value)
  if (value && typeof value === 'object' && 'schemaVersion' in value && value.schemaVersion === 10)
    return upgradeSchemeV10(value)
  if (value && typeof value === 'object' && 'schemaVersion' in value && value.schemaVersion === 11)
    return upgradeSchemeV11(value)
  return schemeSchema.parse(value)
}
