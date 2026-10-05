import type { ZodIssue } from 'zod'
import { legacyV1Schema, type LegacyV1 } from './legacy-v1'
import {
  schemeSchema,
  schemeV2Schema,
  schemeV3Schema,
  schemeV4Schema,
  schemeV5Schema,
  schemeV6Schema,
  schemeV7Schema,
  schemeV8Schema,
  schemeV9Schema,
  upgradeSchemeV8,
  upgradeSchemeV9,
  upgradeSchemeV7,
  upgradeSchemeV4,
  upgradeSchemeV5,
  upgradeSchemeV6,
  upgradeSchemeV2,
  upgradeSchemeV3,
  defaultLegacyParameters,
  type Scheme,
  type WorkZone,
} from './model'
import { responsibleFromLegacy } from './title-block'

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
  format:
    | 'legacy-v1'
    | 'scheme-v2'
    | 'scheme-v3'
    | 'scheme-v4'
    | 'scheme-v5'
    | 'scheme-v6'
    | 'scheme-v7'
    | 'scheme-v8'
    | 'scheme-v9'
    | 'scheme-v10'
  warnings: string[]
}

/** До v7 скорость на подходе вне населённого пункта не вводилась. */
/**
 * Стойки прежнего формата, подпись расстояния которых не удалось перевести в метры. Сообщение
 * показывается при открытии и файла, и проекта из локальной базы, сохранённого до v10.
 */
export function freePostWarning(scheme: Scheme): string[] {
  const ids = scheme.placements.flatMap((placement) =>
    placement.kind === 'sign-post' && !placement.distance && placement.distanceLabel
      ? [placement.id]
      : [],
  )
  return ids.length
    ? [
        `У стоек № ${ids.join(', ')} расстояние записано текстом и не переведено в метры: они остались на прежнем месте листа. Укажите расстояние до начала работ на этапе 3.`,
      ]
    : []
}

function approachWarning(scheme: Scheme): string[] {
  return scheme.parameters.approachSpeedKmh === null
    ? [
        'Разрешённая скорость на подходе в прежнем формате не хранилась. Укажите её на этапе 2 — от неё считаются ступени скорости по умолчанию.',
      ]
    : []
}

/** Прежние строки ответственных разбираются автоматически — составитель должен это проверить. */
function responsibleWarning(lines: readonly string[]): string[] {
  return lines.some((line) => line.trim())
    ? [
        'Ответственные разделены на должность, ФИО и телефон автоматически — проверьте их в «Реквизиты листа» на этапе 4.',
      ]
    : []
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

function warnUnknownLegacyFields(legacy: LegacyV1, warnings: string[]): void {
  function check(value: object, path: string, fields: string[]): void {
    const expected = new Set(fields)
    for (const key of Object.keys(value)) {
      if (!expected.has(key)) {
        warnings.push(`Неизвестное поле ${path}${key} сохранено только в исходном JSON v1.`)
      }
    }
  }
  check(legacy, '', ['v', 'params', 'head', 'objects', 'nid'])
  check(legacy.params, 'params.', [
    'key',
    'variant',
    'peregon',
    'dirL',
    'dirR',
    'd300',
    'd250',
    'd150',
    'd50',
    'n100',
    'n50',
    's1',
    's2',
    's3',
    'yellow',
    'len',
    'reg',
    'loc',
    'size',
    'vIn',
    'locLast',
    'zPu',
    'front',
  ])
  check(legacy.head, 'head.', [
    'dev_org',
    'dev_fio',
    'dev_date',
    'org',
    'work',
    'term',
    'resp1',
    'resp2',
    'ap_pos',
    'ap_org',
    'ap_fio',
    'ag_pos',
    'ag_fio',
    'year',
  ])
  check(legacy.params.len, 'params.len.', ['b33', 'b34'])
  for (const code of ['b33', 'b34'] as const) {
    check(legacy.params.len[code], `params.len.${code}.`, [
      'taper',
      'buffer',
      'zone',
      'lTaper',
      'lBuffer',
      'lZone',
    ])
  }
  if (legacy.params.reg) {
    check(legacy.params.reg, 'params.reg.', ['mode', 'hourly', 'k', 'vis', 'straight', 'last'])
  }
  for (const [index, object] of legacy.objects.entries()) {
    check(
      object,
      `objects.${index}.`,
      object.t === 'post'
        ? ['t', 'id', 'signs', 'anchor', 'dx', 'dy', 'side', 'stand', 'dist', 'auto']
        : ['t', 'id', 'e', 'anchor', 'dx', 'y', 'w', 'h', 'text', 'size', 'bold', 'auto', 'fz'],
    )
  }
}

/**
 * В HTML-прототипе флаг `vis` означает «видимость встречного автомобиля обеспечена», а в проекте
 * v5 — «видимость ограничена» (подпись формы и проверки шаблона). Поля копируются явно: лишние
 * ключи v1 уже попали в предупреждения и не должны ронять импорт.
 */
export function legacyRegulation(reg: NonNullable<LegacyV1['params']['reg']>) {
  return {
    mode: reg.mode,
    hourly: reg.hourly,
    k: reg.k,
    vis: !reg.vis,
    straight: reg.straight,
    last: reg.last,
  }
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
  warnUnknownLegacyFields(legacy, warnings)
  warnings.push(...responsibleWarning([legacy.head.resp1, legacy.head.resp2]))
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
    schemaVersion: 9,
    id,
    createdAt: now,
    crossing: { referenceId: params.key, source: 'legacy-pu66', snapshot: null },
    template: {
      code: params.variant,
      sourceReference: 'ОДМ 218.6.019-2016',
      reviewStatus: 'not-verified',
      projectionVersion: 'draft-1',
    },
    signImages: { catalog: null, revisions: {} },
    parameters: {
      locationText: params.peregon,
      directions: { left: params.dirL, right: params.dirR },
      signDistancesMetres: {
        d300: distanceMetres(params.d300, 'd300', warnings),
        d250: distanceMetres(params.d250, 'd250', warnings),
        d150: distanceMetres(params.d150, 'd150', warnings),
        d50: distanceMetres(params.d50, 'd50', warnings),
        n100: params.n100 === undefined ? null : distanceMetres(params.n100, 'n100', warnings),
        n50: params.n50 === undefined ? null : distanceMetres(params.n50, 'n50', warnings),
      },
      location: params.loc ?? defaultLegacyParameters.location,
      signSize: params.size ?? defaultLegacyParameters.signSize,
      // В прототипе скорость vIn вводилась только для населённого пункта.
      approachSpeedKmh:
        (params.loc ?? defaultLegacyParameters.location) === 'out'
          ? null
          : (params.vIn ?? defaultLegacyParameters.settlementSpeedKmh),
      lastSettlement: params.locLast ?? defaultLegacyParameters.lastSettlement,
      frontStyle: params.front ?? defaultLegacyParameters.frontStyle,
      frontFromPu66: params.zPu ?? defaultLegacyParameters.frontFromPu66,
      regulation: params.reg ? legacyRegulation(params.reg) : defaultLegacyParameters.regulation,
      speedStagesKmh: [params.s1, params.s2, params.s3],
      yellowTemporarySigns: params.yellow,
      workZones: { b33: mapWorkZone(params.len.b33), b34: mapWorkZone(params.len.b34) },
    },
    titleBlock: {
      developer: {
        organization: head.dev_org,
        position: '',
        name: head.dev_fio,
        date: head.dev_date,
      },
      work: { organization: head.org, description: head.work, period: head.term },
      responsible: responsibleFromLegacy(head.resp1, head.resp2),
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
            position: {
              anchor: object.anchor,
              offsetXSvg: object.dx,
              ySvg: object.y,
              ...(object.fz === undefined ? {} : { zoneFraction: object.fz }),
            },
            sizeSvg: { width: object.w, height: object.h },
            text: object.text ?? null,
            fontSizeSvg: object.size ?? null,
            bold: object.bold ?? false,
          },
    ),
    nextPlacementId,
    reviewMarks: {},
    source: { kind: 'legacy-html-v1', importedAt: now, originalJson },
  }

  // Прежний файл описывается в формате v9 и поднимается общей миграцией: расстояния стоек
  // выводятся из их подписей так же, как у сохранённых проектов.
  const parsed = schemeV9Schema.safeParse(candidate)
  if (!parsed.success) invalidIssue(parsed.error.issues)
  const scheme = upgradeSchemeV9(parsed.data)
  return {
    scheme,
    format: 'legacy-v1',
    warnings: [...warnings, ...approachWarning(scheme)],
  }
}

export function importSchemeJson(
  json: string,
  options: { id?: string; now?: string } = {},
): ImportResult {
  const result = readSchemeJson(json, options)
  return result.format === 'scheme-v10'
    ? result
    : { ...result, warnings: [...result.warnings, ...freePostWarning(result.scheme)] }
}

function readSchemeJson(json: string, options: { id?: string; now?: string }): ImportResult {
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
      warnings: [
        'Импортированная схема пока не проверена по действующим нормативным источникам.',
        ...responsibleWarning(parsed.data.titleBlock.responsible),
      ],
    }
  }

  if ('schemaVersion' in value && value.schemaVersion === 3) {
    const parsed = schemeV3Schema.safeParse(value)
    if (!parsed.success) invalidIssue(parsed.error.issues)
    return {
      scheme: upgradeSchemeV3(parsed.data),
      format: 'scheme-v3',
      warnings: [
        'Импортированная схема пока не проверена по действующим нормативным источникам.',
        ...responsibleWarning(parsed.data.titleBlock.responsible),
      ],
    }
  }

  if ('schemaVersion' in value && value.schemaVersion === 4) {
    const parsed = schemeV4Schema.safeParse(value)
    if (!parsed.success) invalidIssue(parsed.error.issues)
    return {
      scheme: upgradeSchemeV4(parsed.data),
      format: 'scheme-v4',
      warnings: [
        'Импортированная схема пока не проверена по действующим нормативным источникам.',
        ...responsibleWarning(parsed.data.titleBlock.responsible),
      ],
    }
  }

  if ('schemaVersion' in value && value.schemaVersion === 5) {
    const parsed = schemeV5Schema.safeParse(value)
    if (!parsed.success) invalidIssue(parsed.error.issues)
    const scheme = upgradeSchemeV5(parsed.data)
    return {
      scheme,
      format: 'scheme-v5',
      warnings: [
        'Импортированная схема пока не проверена по действующим нормативным источникам.',
        ...responsibleWarning(parsed.data.titleBlock.responsible),
        ...approachWarning(scheme),
      ],
    }
  }

  if ('schemaVersion' in value && value.schemaVersion === 6) {
    const parsed = schemeV6Schema.safeParse(value)
    if (!parsed.success) invalidIssue(parsed.error.issues)
    const scheme = upgradeSchemeV6(parsed.data)
    return {
      scheme,
      format: 'scheme-v6',
      warnings: [
        'Импортированная схема пока не проверена по действующим нормативным источникам.',
        ...approachWarning(scheme),
      ],
    }
  }

  if ('schemaVersion' in value && value.schemaVersion === 7) {
    const parsed = schemeV7Schema.safeParse(value)
    if (!parsed.success) invalidIssue(parsed.error.issues)
    return {
      scheme: upgradeSchemeV7(parsed.data),
      format: 'scheme-v7',
      warnings: [
        'Условия длительности, дневных работ и присутствия регулировщиков в прежнем формате не хранились. Заполните их на этапе 2.',
      ],
    }
  }

  if ('schemaVersion' in value && value.schemaVersion === 8) {
    const parsed = schemeV8Schema.safeParse(value)
    if (!parsed.success) invalidIssue(parsed.error.issues)
    return {
      scheme: upgradeSchemeV8(parsed.data),
      format: 'scheme-v8',
      warnings: [
        'Условия справочника и снимки решений в прежнем формате не хранились. Старые скорости и объекты сохранены; основания можно записать на этапе 2.',
      ],
    }
  }

  if ('schemaVersion' in value && value.schemaVersion === 9) {
    const parsed = schemeV9Schema.safeParse(value)
    if (!parsed.success) invalidIssue(parsed.error.issues)
    const scheme = upgradeSchemeV9(parsed.data)
    return {
      scheme,
      format: 'scheme-v9',
      warnings: ['Импортированная схема пока не проверена по действующим нормативным источникам.'],
    }
  }

  if ('schemaVersion' in value && value.schemaVersion === 10) {
    const parsed = schemeSchema.safeParse(value)
    if (!parsed.success) invalidIssue(parsed.error.issues)
    return {
      scheme: parsed.data,
      format: 'scheme-v10',
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
    'Версия проекта не поддерживается. Поддерживаются v: 1 и schemaVersion: 2–10.',
  )
}

export function exportSchemeJson(scheme: Scheme): string {
  const parsed = schemeSchema.safeParse(scheme)
  if (!parsed.success) invalidIssue(parsed.error.issues)
  return `${JSON.stringify(parsed.data, null, 2)}\n`
}
