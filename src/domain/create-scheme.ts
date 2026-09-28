import { defaultLegacyParameters, schemeSchema, type Scheme } from './model'
import { selectTemplateByWorkFront } from './registry'

export type NewSchemeInput = {
  referenceId: string
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

export function createNewScheme(
  input: NewSchemeInput,
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
    schemaVersion: 5,
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
      projectionVersion: 'draft-1',
    },
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
      developer: { organization: '', name: '', date: '' },
      work: { organization: '', description: '', period: '' },
      responsible: ['', ''],
      approver: { position: '', organization: '', name: '' },
      agreement: { position: '', name: '', year: '' },
    },
    placements: [],
    nextPlacementId: 1,
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
