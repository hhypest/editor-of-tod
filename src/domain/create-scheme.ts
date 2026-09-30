import { defaultLegacyParameters, schemeSchema, type Scheme } from './model'
import { linkPu66Card } from './link-pu66'
import type { Pu66SchemeRecord } from './pu66-snapshot'
import { selectTemplateByWorkFront } from './registry'

/** Условия новой схемы, которые составитель вводит сам; переезд задаёт карточка ПУ-66. */
export type NewSchemeInput = {
  locationText: string
  directionLeft: string
  directionRight: string
  frontMetres: string
  taperMetres: string
  bufferMetres: string
  speedStagesKmh: [string, string, string]
  yellowTemporarySigns: boolean
}

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
  options: { id?: string; now?: string } = {},
): Scheme {
  if (!input.referenceId.trim()) {
    throw new SchemeCreationError('Укажите локальный идентификатор переезда.')
  }
  const workMetres = positiveNumber(input.frontMetres, 'фронт работ')
  const taperMetres = positiveNumber(input.taperMetres, 'отвод')
  const bufferMetres = positiveNumber(input.bufferMetres, 'буфер')
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
    schemaVersion: 6,
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
      signDistancesMetres: { d300: null, d250: null, d150: null, d50: null, n100: null, n50: null },
      ...defaultLegacyParameters,
      speedStagesKmh: speeds,
      yellowTemporarySigns: input.yellowTemporarySigns,
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
  options: { id?: string; now?: string } = {},
): Scheme {
  if (!card?.referenceId.trim()) {
    throw new SchemeCreationError(
      'Новую схему можно начать только с карточки ПУ-66 из локального реестра. Выберите карточку.',
    )
  }
  return linkPu66Card(
    createUnlinkedScheme({ ...input, referenceId: card.referenceId }, options),
    card,
  )
}
