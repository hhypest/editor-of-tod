import type { ZodIssue } from 'zod'
import { legacyV1Schema, type LegacyV1 } from './legacy-v1'
import { schemeSchema, schemeV2Schema, upgradeSchemeV2, type Scheme, type WorkZone } from './model'

export const MAX_PROJECT_FILE_BYTES = 32 * 1024 * 1024
const MAX_LEGACY_FILE_BYTES = 10 * 1024 * 1024

export class SchemeImportError extends Error {
  constructor(
    public readonly code: 'too-large' | 'invalid-json' | 'unsupported-version' | 'invalid-data',
    message: string,
    public readonly field?: string,
  ) {
    super(message)
    this.name = 'SchemeImportError'
  }
}

export interface ImportResult {
  scheme: Scheme
  format: 'legacy-v1' | 'scheme-v2' | 'scheme-v3'
  warnings: string[]
}

function invalidIssue(issues: ZodIssue[]): never {
  const issue = issues[0]
  const field = issue?.path.map(String).join('.') || 'проект'
  throw new SchemeImportError(
    'invalid-data',
    `Поле «${field}» отсутствует или имеет неверный формат.`,
    field,
  )
}

function mapWorkZone(zone: LegacyV1['params']['len']['b33']): WorkZone {
  return {
    taperMetres: zone.taper,
    bufferMetres: zone.buffer,
    workMetres: zone.zone,
    labels: { taper: zone.lTaper, buffer: zone.lBuffer, work: zone.lZone },
  }
}

function distanceMetres(value: string | number, field: string, warnings: string[]): number | null {
  if (typeof value === 'string' && value.trim() === '') {
    warnings.push(`Расстояние ${field} не заполнено в исходном проекте.`)
    return null
  }

  const source = String(value).trim().replace(',', '.')
  if (!/^\d+(?:\.\d+)?$/.test(source) || !Number.isFinite(Number(source))) {
    throw new SchemeImportError(
      'invalid-data',
      `Расстояние «${field}» должно быть числом.`,
      `params.${field}`,
    )
  }
  return Number(source)
}

function migrateLegacy(
  legacy: LegacyV1,
  originalJson: string,
  id: string,
  now: string,
): ImportResult {
  const warnings = [
    'Сведения о переезде не сверены с актуальной карточкой ПУ-66.',
    'Шаблон и номера знаков перенесены как данные; нормативная проверка не выполняется, изображения доступны только из локального каталога PNG.',
  ]
  const seen = new Set<number>()
  for (const [index, object] of legacy.objects.entries()) {
    if (seen.has(object.id)) {
      throw new SchemeImportError(
        'invalid-data',
        `Повторяющийся номер объекта: ${object.id}.`,
        `objects.${index}.id`,
      )
    }
    seen.add(object.id)
    if (object.t === 'el' && object.e === 'text' && object.text === undefined) {
      throw new SchemeImportError(
        'invalid-data',
        'У надписи отсутствует текст.',
        `objects.${index}.text`,
      )
    }
  }

  const highestId = Math.max(0, ...seen)
  const nextPlacementId = Math.max(legacy.nid, highestId + 1)
  if (legacy.nid < nextPlacementId) {
    warnings.push(
      'Счётчик объектов в старом файле устарел; для новых объектов будет использован следующий свободный номер.',
    )
  }

  const { params, head } = legacy
  const candidate = {
    schemaVersion: 3,
    id,
    createdAt: now,
    crossing: { referenceId: params.key, source: 'legacy-pu66', snapshot: null },
    template: {
      code: params.variant,
      sourceReference: 'ОДМ 218.6.019-2016',
      reviewStatus: 'not-verified',
    },
    parameters: {
      locationText: params.peregon,
      directions: { left: params.dirL, right: params.dirR },
      signDistancesMetres: {
        d300: distanceMetres(params.d300, 'd300', warnings),
        d250: distanceMetres(params.d250, 'd250', warnings),
        d150: distanceMetres(params.d150, 'd150', warnings),
        d50: distanceMetres(params.d50, 'd50', warnings),
      },
      speedStagesKmh: [params.s1, params.s2, params.s3],
      yellowTemporarySigns: params.yellow,
      workZones: { b33: mapWorkZone(params.len.b33), b34: mapWorkZone(params.len.b34) },
    },
    titleBlock: {
      developer: { organization: head.dev_org, name: head.dev_fio, date: head.dev_date },
      work: { organization: head.org, description: head.work, period: head.term },
      responsible: [head.resp1, head.resp2],
      approver: { position: head.ap_pos, organization: head.ap_org, name: head.ap_fio },
      agreement: { position: head.ag_pos, name: head.ag_fio, year: head.year },
    },
    placements: legacy.objects.map((object) =>
      object.t === 'post'
        ? {
            kind: 'sign-post',
            id: object.id,
            generatedByTemplate: object.auto === 1,
            position: { anchor: object.anchor, offsetXSvg: object.dx, offsetYSvg: object.dy ?? 0 },
            side: object.side,
            stand: object.stand,
            signIds: object.signs,
            distanceLabel: object.dist,
          }
        : {
            kind: 'element',
            id: object.id,
            generatedByTemplate: object.auto === 1,
            elementKind: object.e,
            position: { anchor: object.anchor, offsetXSvg: object.dx, ySvg: object.y },
            sizeSvg: { width: object.w, height: object.h },
            text: object.text ?? null,
            fontSizeSvg: object.size ?? null,
            bold: object.bold ?? false,
          },
    ),
    nextPlacementId,
    source: { kind: 'legacy-html-v1', importedAt: now, originalJson },
  }

  const parsed = schemeSchema.safeParse(candidate)
  if (!parsed.success) invalidIssue(parsed.error.issues)
  return { scheme: parsed.data, format: 'legacy-v1', warnings }
}

export function importSchemeJson(
  json: string,
  options: { id?: string; now?: string } = {},
): ImportResult {
  if (new TextEncoder().encode(json).length > MAX_PROJECT_FILE_BYTES) {
    throw new SchemeImportError('too-large', 'Файл проекта больше 32 МБ.')
  }

  let value: unknown
  try {
    value = JSON.parse(json)
  } catch {
    throw new SchemeImportError('invalid-json', 'Файл не содержит корректный JSON.')
  }

  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new SchemeImportError('invalid-data', 'Корень проекта должен быть объектом JSON.')
  }

  if ('schemaVersion' in value && value.schemaVersion === 2) {
    const parsed = schemeV2Schema.safeParse(value)
    if (!parsed.success) invalidIssue(parsed.error.issues)
    return {
      scheme: upgradeSchemeV2(parsed.data),
      format: 'scheme-v2',
      warnings: ['Импортированная схема пока не проверена по действующим нормативным источникам.'],
    }
  }

  if ('schemaVersion' in value && value.schemaVersion === 3) {
    const parsed = schemeSchema.safeParse(value)
    if (!parsed.success) invalidIssue(parsed.error.issues)
    return {
      scheme: parsed.data,
      format: 'scheme-v3',
      warnings: ['Импортированная схема пока не проверена по действующим нормативным источникам.'],
    }
  }

  if ('v' in value && value.v === 1) {
    if (new TextEncoder().encode(json).length > MAX_LEGACY_FILE_BYTES) {
      throw new SchemeImportError('too-large', 'Исходный файл v1 больше 10 МБ.')
    }
    const parsed = legacyV1Schema.safeParse(value)
    if (!parsed.success) invalidIssue(parsed.error.issues)
    return migrateLegacy(
      parsed.data,
      json,
      options.id ?? crypto.randomUUID(),
      options.now ?? new Date().toISOString(),
    )
  }

  throw new SchemeImportError(
    'unsupported-version',
    'Версия проекта не поддерживается. Поддерживаются v: 1 и schemaVersion: 2 или 3.',
  )
}

export function exportSchemeJson(scheme: Scheme): string {
  const parsed = schemeSchema.safeParse(scheme)
  if (!parsed.success) invalidIssue(parsed.error.issues)
  return `${JSON.stringify(parsed.data, null, 2)}\n`
}
