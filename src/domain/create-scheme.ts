import { CROSSING_FRONT_LIMIT_METRES } from './crossing-limits'
import { defaultLegacyParameters, schemeSchema, type Scheme } from './model'
import { linkPu66Card } from './link-pu66'
import {
  defaultSpeedStages,
  expectedTypesize,
  fillDistanceDefaults,
  type SchemeLocation,
} from './normative-defaults'
import { PROTOTYPE_RULES, type NormativeRules } from './normative-parameters'
import type { Pu66SchemeRecord } from './pu66-snapshot'
import { selectTemplateByWorkFront } from './registry'
import { cellNumber } from './pu66-norms'

/** Условия новой схемы, которые составитель вводит сам; переезд задаёт карточка ПУ-66. */
export type NewSchemeInput = {
  locationText: string
  directionLeft: string
  directionRight: string
  frontMetres: string
  taperMetres: string
  bufferMetres: string
  /** Выбирается при создании: от него зависят расстояния и скорость по умолчанию. */
  location: SchemeLocation | ''
  approachSpeedKmh: string
  speedStagesKmh: [string, string, string]
  yellowTemporarySigns: boolean
  workConditions?: Scheme['parameters']['workConditions']
  frontFromPu66?: boolean
}

/**
 * Значения формы после выбора местоположения: разрешённая скорость и ступени 3.24 из
 * нормативных параметров. Расстояния до знаков подставляются при создании проекта.
 */
export function newSchemeDefaults(
  location: SchemeLocation,
  rules: NormativeRules,
): Pick<NewSchemeInput, 'approachSpeedKmh' | 'speedStagesKmh'> {
  const approach = rules.allowedSpeedKmh[location]
  return {
    approachSpeedKmh: String(approach),
    speedStagesKmh: defaultSpeedStages(approach, rules).map(String) as [string, string, string],
  }
}

const { settlementSpeedKmh: _settlementSpeed, ...legacyParameters } = defaultLegacyParameters
void _settlementSpeed

export class SchemeCreationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SchemeCreationError'
  }
}

function positiveNumber(value: string, label: string): number {
  const normalized = value.trim().replace(',', '.')
  if (!/^(?:\d+)(?:\.\d+)?$/.test(normalized) || Number(normalized) <= 0) {
    throw new SchemeCreationError(`Поле «${label}»: укажите положительное число.`)
  }
  const result = Number(normalized)
  if (!Number.isFinite(result))
    throw new SchemeCreationError(`Поле «${label}»: число слишком велико.`)
  return result
}

/**
 * Проект без закреплённой карточки — такими были проекты до 30.09.2026 и импортированные v1.
 * Интерфейс так новые схемы не создаёт (см. {@link createSchemeFromPu66}); функция нужна
 * для проверки введённых условий и для тестов.
 */
export function createUnlinkedScheme(
  input: NewSchemeInput & { referenceId: string },
  options: { id?: string; now?: string; rules?: NormativeRules } = {},
): Scheme {
  if (!input.referenceId.trim()) {
    throw new SchemeCreationError('Укажите локальный идентификатор переезда.')
  }
  const workMetres = positiveNumber(input.frontMetres, 'фронт работ')
  const profileMaximum = CROSSING_FRONT_LIMIT_METRES
  if (workMetres > profileMaximum)
    throw new SchemeCreationError(
      `Фронт работ превышает предел фронта редактора ${profileMaximum} м.`,
    )
  const taperMetres = positiveNumber(input.taperMetres, 'отвод')
  const bufferMetres = positiveNumber(input.bufferMetres, 'буфер')
  if (input.location !== 'in' && input.location !== 'out') {
    throw new SchemeCreationError(
      'Укажите, находится ли место работ в населённом пункте: от этого зависят расстояния до знаков и скорости.',
    )
  }
  const approachSpeedKmh = positiveNumber(input.approachSpeedKmh, 'разрешённая скорость на подходе')
  const speeds = input.speedStagesKmh.map((value, index) =>
    positiveNumber(value, `скорость ${index + 1}`),
  ) as [number, number, number]
  const { code } = selectTemplateByWorkFront(workMetres)
  const zone = {
    taperMetres,
    bufferMetres,
    workMetres,
    labels: { taper: '', buffer: '', work: '' },
  }
  const parsed = schemeSchema.safeParse({
    schemaVersion: 8,
    id: options.id ?? crypto.randomUUID(),
    createdAt: options.now ?? new Date().toISOString(),
    crossing: {
      referenceId: input.referenceId.trim(),
      source: 'entered-by-editor',
      snapshot: null,
    },
    template: {
      code,
      sourceReference: 'ОДМ 218.6.019-2016',
      reviewStatus: 'not-verified',
      projectionVersion: 'draft-2',
    },
    signImages: { catalog: null, revisions: {} },
    parameters: {
      locationText: input.locationText.trim(),
      directions: { left: input.directionLeft.trim(), right: input.directionRight.trim() },
      signDistancesMetres: fillDistanceDefaults(
        { d300: null, d250: null, d150: null, d50: null, n100: null, n50: null },
        input.location,
        options.rules ?? PROTOTYPE_RULES,
      ),
      ...legacyParameters,
      frontFromPu66: input.frontFromPu66 ?? false,
      location: input.location,
      // Типоразмер по таблице 1 ГОСТ Р 52289 для двухполосной дороги; в населённом пункте — по
      // классу улицы, его выбирает составитель.
      signSize: expectedTypesize(input.location, options.rules ?? PROTOTYPE_RULES) ?? 'auto',
      approachSpeedKmh,
      speedStagesKmh: speeds,
      yellowTemporarySigns: input.yellowTemporarySigns,
      ...(input.workConditions ? { workConditions: input.workConditions } : {}),
      workZones: { b33: code === 'b33' ? zone : null, b34: code === 'b34' ? zone : null },
    },
    titleBlock: {
      developer: { organization: '', position: '', name: '', date: '' },
      work: { organization: '', description: '', period: '' },
      responsible: [{ position: '', name: '', phone: '' }],
      approver: { position: '', organization: '', name: '' },
      agreement: { position: '', name: '', year: '' },
    },
    placements: [],
    nextPlacementId: 1,
    reviewMarks: {},
    source: { kind: 'created-in-editor' },
  })
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw new SchemeCreationError(
      `Поле «${issue?.path.join('.') ?? 'проект'}»: ${issue?.message ?? 'недопустимое значение'}.`,
    )
  }
  return parsed.data
}

/**
 * Единственный способ начать новую схему: идентификатор берётся из карточки ПУ-66 локального
 * реестра, в проект попадает только разрешённая выборка выбранной редакции.
 */
export function createSchemeFromPu66(
  input: NewSchemeInput,
  card: Pu66SchemeRecord | null | undefined,
  options: { id?: string; now?: string; rules?: NormativeRules } = {},
): Scheme {
  if (!card?.referenceId.trim()) {
    throw new SchemeCreationError(
      'Новую схему можно начать только с карточки ПУ-66 из локального реестра. Выберите карточку.',
    )
  }
  const maximum = cellNumber(card.crossingRoadLengthMetres)
  if (maximum !== null && maximum > 0 && positiveNumber(input.frontMetres, 'фронт работ') > maximum)
    throw new SchemeCreationError(
      `Фронт работ превышает ${maximum} м — длину в границах переезда из п. 8 выбранной карточки ПУ-66. Отгон и буфер учитываются отдельно.`,
    )
  return linkPu66Card(
    createUnlinkedScheme({ ...input, referenceId: card.referenceId }, options),
    card,
  )
}
