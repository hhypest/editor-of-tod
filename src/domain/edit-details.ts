import { schemeSchema, type Scheme, type WorkZone } from './model'

type WorkZoneDraft = {
  taperMetres: string
  bufferMetres: string
  workMetres: string
  labels: WorkZone['labels']
}

export type SchemeDetailsDraft = {
  parameters: {
    locationText: string
    directions: Scheme['parameters']['directions']
    signDistancesMetres: Record<'d300' | 'd250' | 'd150' | 'd50', string>
    speedStagesKmh: [string, string, string]
    yellowTemporarySigns: boolean
    workZones: { b33: WorkZoneDraft | null; b34: WorkZoneDraft | null }
  }
  titleBlock: Scheme['titleBlock']
}

export class SchemeEditError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SchemeEditError'
  }
}

function zoneDraft(zone: WorkZone): WorkZoneDraft {
  return {
    taperMetres: String(zone.taperMetres),
    bufferMetres: String(zone.bufferMetres),
    workMetres: String(zone.workMetres),
    labels: { ...zone.labels },
  }
}

export function createSchemeDetailsDraft(scheme: Scheme): SchemeDetailsDraft {
  const { parameters } = scheme
  return {
    parameters: {
      locationText: parameters.locationText,
      directions: { ...parameters.directions },
      signDistancesMetres: {
        d300: parameters.signDistancesMetres.d300?.toString() ?? '',
        d250: parameters.signDistancesMetres.d250?.toString() ?? '',
        d150: parameters.signDistancesMetres.d150?.toString() ?? '',
        d50: parameters.signDistancesMetres.d50?.toString() ?? '',
      },
      speedStagesKmh: [
        String(parameters.speedStagesKmh[0]),
        String(parameters.speedStagesKmh[1]),
        String(parameters.speedStagesKmh[2]),
      ],
      yellowTemporarySigns: parameters.yellowTemporarySigns,
      workZones: {
        b33: parameters.workZones.b33 ? zoneDraft(parameters.workZones.b33) : null,
        b34: parameters.workZones.b34 ? zoneDraft(parameters.workZones.b34) : null,
      },
    },
    titleBlock: structuredClone(scheme.titleBlock),
  }
}

function metres(value: string, field: string, optional = false): number | null {
  const normalized = value.trim().replace(',', '.')
  if (optional && normalized === '') return null
  if (!/^\d+(?:\.\d+)?$/.test(normalized)) {
    throw new SchemeEditError(
      `Поле «${field}»: укажите ${optional ? 'неотрицательное число или оставьте пустым' : 'положительное число'}.`,
    )
  }
  const number = Number(normalized)
  if (!Number.isFinite(number) || (!optional && number <= 0)) {
    throw new SchemeEditError(
      `Поле «${field}»: значение должно быть ${optional ? 'конечным неотрицательным' : 'конечным положительным'} числом.`,
    )
  }
  return number
}

function requiredMetres(value: string, field: string): number {
  const parsed = metres(value, field)
  if (parsed === null) throw new SchemeEditError(`Поле «${field}» обязательно.`)
  return parsed
}

function parseZone(zone: WorkZoneDraft | null, name: string): WorkZone | null {
  if (!zone) return null
  return {
    taperMetres: requiredMetres(zone.taperMetres, `${name}: отвод`),
    bufferMetres: requiredMetres(zone.bufferMetres, `${name}: буфер`),
    workMetres: requiredMetres(zone.workMetres, `${name}: фронт работ`),
    labels: { ...zone.labels },
  }
}

export function applySchemeDetails(scheme: Scheme, draft: SchemeDetailsDraft): Scheme {
  const { parameters } = draft
  const candidate = {
    ...scheme,
    parameters: {
      ...scheme.parameters,
      locationText: parameters.locationText,
      directions: { ...parameters.directions },
      signDistancesMetres: {
        d300: metres(parameters.signDistancesMetres.d300, 'd300', true),
        d250: metres(parameters.signDistancesMetres.d250, 'd250', true),
        d150: metres(parameters.signDistancesMetres.d150, 'd150', true),
        d50: metres(parameters.signDistancesMetres.d50, 'd50', true),
      },
      speedStagesKmh: [
        requiredMetres(parameters.speedStagesKmh[0], 'первая ступень скорости'),
        requiredMetres(parameters.speedStagesKmh[1], 'вторая ступень скорости'),
        requiredMetres(parameters.speedStagesKmh[2], 'третья ступень скорости'),
      ],
      yellowTemporarySigns: parameters.yellowTemporarySigns,
      workZones: {
        b33: parseZone(parameters.workZones.b33, 'Б.33'),
        b34: parseZone(parameters.workZones.b34, 'Б.34'),
      },
    },
    titleBlock: structuredClone(draft.titleBlock),
  }
  const checked = schemeSchema.safeParse(candidate)
  if (!checked.success) {
    const issue = checked.error.issues[0]
    throw new SchemeEditError(
      `Поле «${issue?.path.join('.') || 'проект'}» не прошло проверку: ${issue?.message || 'недопустимое значение'}.`,
    )
  }
  return checked.data
}
