import { z } from 'zod'
import { normalizeQuote } from './document-text.ts'

/**
 * Нормативные параметры, которые использует программа. Каждый привязан к документу и пункту;
 * программа находит пункт в PDF библиотеки, предлагает значение из текста, а составитель
 * подтверждает его. Подтверждённое значение действует для текущей редакции документа. После
 * смены редакции программа сравнивает фрагмент пункта и просит подтвердить заново.
 * Пока значение не подтверждено, расчёты используют значения прототипа и помечают это.
 */

export type ParameterSource =
  | { kind: 'clause'; documentCode: string; clause: string }
  | { kind: 'table'; documentCode: string; table: string; clause: string }
  /** Решение составителя без пункта документа: основание записывается при подтверждении. */
  | { kind: 'decision' }

export type NumberParameter = {
  id: string
  title: string
  unit: string
  usedIn: string
  source: ParameterSource
  type: 'number'
  /** Значение прототипа до подтверждения; null — без подтверждения не используется. */
  fallback: number | null
  min: number
  max: number
  /** Выражение, находящее значение во фрагменте пункта (первая группа). */
  pattern?: RegExp
}

export type TableParameter = {
  id: string
  title: string
  unit: string
  usedIn: string
  source: ParameterSource
  type: 'table'
  /** Строки таблицы: ключ → значение; подписи ключей и значений. */
  keyLabel: string
  valueLabel: string
  fallback: Record<string, string>
  /** Строка таблицы в тексте: ключ и значение (первые две группы). */
  rowPattern?: RegExp
  /** Допустимые значения ячеек. */
  valuePattern: RegExp
}

export type ParameterDefinition = NumberParameter | TableParameter

export const ODM = 'ОДМ 218.6.019'
export const GOST_RULES = 'ГОСТ Р 52289'

/** Строки таблиц расстояний по умолчанию → поля проекта (подписи видит составитель). */
export const OUTSIDE_DISTANCE_KEYS = {
  d300: 'Знак 1.25 «Дорожные работы»',
  d250: 'Первая ступень 3.24 и знак 3.20',
  d150: 'Вторая ступень 3.24 и сужение 1.20',
  d50: 'Знак скорости в зоне работ 3.24',
} as const
export const SETTLEMENT_DISTANCE_KEYS = {
  n100: 'Знак 1.25 и ступени 3.24',
  n50: 'Знак скорости в зоне работ 3.24 и сужение 1.20',
} as const
export const WARNING_RANGE_KEYS = {
  out: 'Вне населённого пункта',
  in: 'В населённом пункте',
} as const

export const parameterDefinitions: readonly ParameterDefinition[] = [
  {
    id: 'odm-signs-hourly',
    title: 'Интенсивность, до которой встречный разъезд регулируют знаками 2.6 и 2.7',
    unit: 'авт/ч',
    usedIn: 'Подсказка способа пропуска Б.34; сборка шаблона со знаками 2.6/2.7',
    source: { kind: 'clause', documentCode: ODM, clause: '5.4.4' },
    type: 'number',
    fallback: 250,
    min: 1,
    max: 5_000,
    pattern: /интенсивностью движения менее (\d+) авт/u,
  },
  {
    id: 'odm-signs-length',
    title: 'Протяжённость участка работ, до которой допускаются знаки 2.6 и 2.7',
    unit: 'м',
    usedIn: 'Подсказка способа пропуска Б.34',
    source: { kind: 'clause', documentCode: ODM, clause: '5.4.4' },
    type: 'number',
    fallback: 50,
    min: 1,
    max: 1_000,
    pattern: /протяженностью менее (\d+) м/u,
  },
  {
    id: 'odm-alternate-hourly',
    title: 'Верхняя граница интенсивности при поочерёдном пропуске по одной полосе',
    unit: 'авт/ч',
    usedIn: 'Предупреждение подсказки способа пропуска',
    source: { kind: 'clause', documentCode: ODM, clause: '5.4.2' },
    type: 'number',
    fallback: 500,
    min: 1,
    max: 5_000,
    pattern: /интенсивности движения от \d+ до (\d+) авт/u,
  },
  {
    id: 'odm-signs-taper',
    title: 'Длина отгона при регулировании знаками 2.6 и 2.7',
    unit: 'м',
    usedIn: 'Подсказка способа пропуска; сборка шаблона со знаками 2.6/2.7',
    source: { kind: 'clause', documentCode: ODM, clause: '4.1.8.3' },
    type: 'number',
    fallback: 15,
    min: 1,
    max: 200,
    pattern: /(\d+) м-с помощью знаков 2\.6/u,
  },
  {
    id: 'odm-regulator-distance',
    title: 'Расстояние от регулировщика до начала рабочей зоны',
    unit: 'м',
    usedIn: 'Подсказка способа пропуска (один или два регулировщика)',
    source: { kind: 'table', documentCode: ODM, table: '5', clause: 'таблица 5' },
    type: 'table',
    keyLabel: 'Скорость на рабочем участке, км/ч',
    valueLabel: 'Расстояние, м',
    fallback: { '30': '10', '40': '15', '50': '30', '60': '45', '70': '65', '80': '85' },
    rowPattern: /^(\d{2,3}) (\d{1,3})$/u,
    valuePattern: /^\d{1,4}$/,
  },
  {
    id: 'gost-speed-step',
    title: 'Наибольший шаг ступенчатого ограничения скорости знаками 3.24',
    unit: 'км/ч',
    usedIn: 'Ступени скорости в населённом пункте при сборке шаблона',
    source: { kind: 'clause', documentCode: GOST_RULES, clause: '5.4.22' },
    type: 'number',
    fallback: 20,
    min: 5,
    max: 60,
    pattern: /с шагом не более (\d+) км\/ч/u,
  },
  {
    id: 'gost-sign-typesize',
    title: 'Типоразмер знаков вне населённых пунктов',
    unit: '',
    usedIn: 'Подсказка типоразмера знаков по категории дороги из ПУ-66',
    source: { kind: 'table', documentCode: GOST_RULES, table: '1', clause: 'п. 5.1.16, таблица 1' },
    type: 'table',
    keyLabel: 'Дорога',
    valueLabel: 'Типоразмер',
    fallback: {
      'одна полоса': 'I',
      'две и три полосы': 'II',
      'четыре и более полос': 'III',
      'работы на дорогах IА и IБ категории': 'IV',
    },
    valuePattern: /^(I|II|III|IV)$/,
  },
  {
    id: 'pdd-speed-settlement',
    title: 'Разрешённая скорость в населённом пункте (значение по умолчанию на подходе)',
    unit: 'км/ч',
    usedIn: 'Подстановка разрешённой скорости на подходе и ступеней 3.24 в населённом пункте',
    source: { kind: 'clause', documentCode: 'ПДД', clause: '10.2' },
    type: 'number',
    fallback: 60,
    min: 5,
    max: 130,
    pattern:
      /в населенных пунктах разрешается движение транспортных средств со скоростью не более (\d+) км/u,
  },
  {
    id: 'pdd-speed-outside',
    title: 'Разрешённая скорость вне населённых пунктов (значение по умолчанию на подходе)',
    unit: 'км/ч',
    usedIn: 'Подстановка разрешённой скорости на подходе и ступеней 3.24 вне населённого пункта',
    source: { kind: 'clause', documentCode: 'ПДД', clause: '10.3' },
    type: 'number',
    fallback: 90,
    min: 5,
    max: 130,
    pattern: /на остальных дорогах-не более (\d+) км\/ч/u,
  },
  {
    id: 'odm-zone-speed',
    title: 'Скорость в зоне работ на рисунках Б.33 и Б.34 (значение по умолчанию)',
    unit: 'км/ч',
    usedIn: 'Подстановка скорости в зоне работ (последняя ступень 3.24)',
    source: { kind: 'table', documentCode: ODM, table: 'Б.33', clause: 'рисунки Б.33 и Б.34' },
    type: 'number',
    fallback: 40,
    min: 5,
    max: 130,
  },
  {
    id: 'odm-sign-distances-outside',
    title: 'Расстояния от стоек до начала работ вне населённого пункта (значения по умолчанию)',
    unit: 'м',
    usedIn: 'Подстановка расстояний до знаков вне населённого пункта',
    source: { kind: 'table', documentCode: ODM, table: 'Б.33', clause: 'рисунки Б.33 и Б.34' },
    type: 'table',
    keyLabel: 'Стойка',
    valueLabel: 'Расстояние до начала работ, м',
    fallback: {
      [OUTSIDE_DISTANCE_KEYS.d300]: '300',
      [OUTSIDE_DISTANCE_KEYS.d250]: '250',
      [OUTSIDE_DISTANCE_KEYS.d150]: '150',
      [OUTSIDE_DISTANCE_KEYS.d50]: '50',
    },
    valuePattern: /^\d{1,4}$/,
  },
  {
    id: 'gost-sign-distances-settlement',
    title:
      'Расстояния от стоек до начала работ в населённом пункте (значения по умолчанию в пределах п. 5.2.2)',
    unit: 'м',
    usedIn: 'Подстановка расстояний до знаков в населённом пункте',
    source: { kind: 'clause', documentCode: GOST_RULES, clause: '5.2.2' },
    type: 'table',
    keyLabel: 'Стойка',
    valueLabel: 'Расстояние до начала работ, м',
    fallback: {
      [SETTLEMENT_DISTANCE_KEYS.n100]: '100',
      [SETTLEMENT_DISTANCE_KEYS.n50]: '50',
    },
    valuePattern: /^\d{1,4}$/,
  },
  {
    id: 'gost-warning-distance',
    title: 'Диапазон расстояний от предупреждающего знака до начала опасного участка',
    unit: 'м',
    usedIn:
      'Предупреждение о расстоянии до знака 1.25 вне диапазона (иное расстояние указывают табличкой 8.1.1)',
    source: { kind: 'clause', documentCode: GOST_RULES, clause: '5.2.2' },
    type: 'table',
    keyLabel: 'Местоположение',
    valueLabel: 'Диапазон, м',
    fallback: {
      [WARNING_RANGE_KEYS.out]: '150–300',
      [WARNING_RANGE_KEYS.in]: '50–100',
    },
    valuePattern: /^\d{1,4}\s*[–-]\s*\d{1,4}$/,
  },
  {
    id: 'peak-hour-share',
    title: 'Доля часа пик в суточной интенсивности (для данных ПУ-66)',
    unit: '',
    usedIn: 'Пересчёт суточной интенсивности ПУ-66 в часовую',
    source: { kind: 'decision' },
    type: 'number',
    fallback: null,
    min: 0.01,
    max: 1,
  },
]

export function parameterDefinition(id: string): ParameterDefinition | undefined {
  return parameterDefinitions.find((definition) => definition.id === id)
}

export const parameterValueSchema = z.union([
  z.number().finite(),
  z.record(z.string().min(1).max(80), z.string().min(1).max(20)),
])
export type ParameterValue = z.infer<typeof parameterValueSchema>

/** Проверка значения по описанию параметра; возвращает текст ошибки или null. */
export function valueProblem(
  definition: ParameterDefinition,
  value: ParameterValue,
): string | null {
  if (definition.type === 'number') {
    if (typeof value !== 'number') return 'Нужно число.'
    if (value < definition.min || value > definition.max)
      return `Допустимо от ${definition.min} до ${definition.max}.`
    return null
  }
  if (typeof value === 'number') return 'Нужна таблица значений.'
  const rows = Object.entries(value)
  if (!rows.length) return 'Таблица пуста.'
  const bad = rows.find(([, cell]) => !definition.valuePattern.test(cell))
  return bad ? `Недопустимое значение «${bad[1]}» для «${bad[0]}».` : null
}

/**
 * Значение, предложенное по тексту пункта: число по выражению параметра или строки таблицы.
 * null — в тексте значение не найдено, его вводит составитель.
 */
export function suggestValue(
  definition: ParameterDefinition,
  quote: { text: string; rows?: readonly string[] } | null,
): ParameterValue | null {
  if (!quote) return null
  if (definition.type === 'number') {
    if (!definition.pattern) return null
    const match = definition.pattern.exec(normalizeQuote(quote.text))
    return match ? Number(match[1]) : null
  }
  if (!definition.rowPattern || !quote.rows) return null
  const rows = quote.rows.flatMap((row) => {
    const match = definition.rowPattern!.exec(row.trim())
    return match ? [[match[1]!, match[2]!] as const] : []
  })
  return rows.length ? Object.fromEntries(rows) : null
}

/**
 * Фрагмент пункта, относящийся к параметру: предложение со значением. По нему сравниваются
 * редакции, чтобы правка соседних предложений пункта не требовала повторного подтверждения.
 */
export function relevantFragment(definition: ParameterDefinition, text: string): string {
  const normalized = normalizeQuote(text)
  if (definition.type !== 'number' || !definition.pattern) return normalized
  const match = definition.pattern.exec(normalized)
  if (!match) return normalized
  const before = normalized.lastIndexOf('. ', match.index)
  const after = normalized.indexOf('. ', match.index + match[0].length)
  return normalized.slice(before < 0 ? 0 : before + 2, after < 0 ? undefined : after + 1).trim()
}

export const confirmationSchema = z.strictObject({
  id: z.number().int().positive(),
  parameterId: z.string(),
  /** Документ библиотеки (редакция), по которому подтверждено значение; null — решение составителя. */
  documentId: z.number().int().positive().nullable(),
  documentLabel: z.string(),
  clause: z.string(),
  page: z.number().int().positive().nullable(),
  quote: z.string(),
  fragment: z.string(),
  value: parameterValueSchema,
  confirmedBy: z.string(),
  confirmedAt: z.string(),
  note: z.string(),
})
export type ParameterConfirmation = z.infer<typeof confirmationSchema>

export type ParameterStatus =
  /** Подтверждено по действующей редакции (или решение составителя). */
  | { kind: 'confirmed' }
  /** Подтверждено по прежней редакции; в действующей фрагмент пункта тот же. */
  | { kind: 'same-text'; previous: string }
  /** Подтверждено по прежней редакции; в действующей фрагмент изменился или не найден. */
  | { kind: 'changed'; previous: string }
  | { kind: 'unconfirmed' }
  /** Документа с этим обозначением нет в библиотеке или действующая редакция не определена. */
  | { kind: 'no-document' }

export const parameterStateSchema = z.strictObject({
  id: z.string(),
  status: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('confirmed') }),
    z.strictObject({ kind: z.literal('same-text'), previous: z.string() }),
    z.strictObject({ kind: z.literal('changed'), previous: z.string() }),
    z.strictObject({ kind: z.literal('unconfirmed') }),
    z.strictObject({ kind: z.literal('no-document') }),
  ]),
  document: z.strictObject({ id: z.number(), label: z.string(), sha256: z.string() }).nullable(),
  quote: z
    .strictObject({ page: z.number(), text: z.string(), rows: z.array(z.string()).optional() })
    .nullable(),
  suggestion: parameterValueSchema.nullable(),
  confirmation: confirmationSchema.nullable(),
  /** Действующие изменения к документу, в тексте которых упоминается пункт. */
  amendments: z.array(z.string()),
})
export type ParameterState = z.infer<typeof parameterStateSchema>

/** Значения, которыми пользуются расчёты, и их происхождение. */
export type NormativeRules = {
  signsHourly: number
  signsLengthMetres: number
  alternateHourly: number
  signsTaperMetres: number
  regulatorDistance: Readonly<Record<number, number>>
  speedStepKmh: number
  typesize: Readonly<Record<string, string>>
  /** Разрешённая скорость по умолчанию на подходе: в населённом пункте и вне его. */
  allowedSpeedKmh: Readonly<{ in: number; out: number }>
  /** Скорость в зоне работ по умолчанию (последняя ступень 3.24). */
  zoneSpeedKmh: number
  /** Расстояния от стоек до начала работ по умолчанию. */
  signDistances: Readonly<{
    d300: number
    d250: number
    d150: number
    d50: number
    n100: number
    n50: number
  }>
  /** Диапазон расстояния до предупреждающего знака; null — значение таблицы не разобрано. */
  warningDistance: Readonly<{
    in: readonly [number, number] | null
    out: readonly [number, number] | null
  }>
  peakHourShare: number | null
  /** Параметр подтверждён для действующей редакции. */
  confirmed: Readonly<Record<string, boolean>>
  /** Ссылка для текста подсказок: «ОДМ 218.6.019-2016, п. 5.4.4». */
  sources: Readonly<Record<string, string>>
}

function fallbackValue(definition: ParameterDefinition): ParameterValue | null {
  return definition.fallback
}

function sourceLabel(definition: ParameterDefinition, documentLabel?: string): string {
  const source = definition.source
  if (source.kind === 'decision') return 'решение составителя'
  const place = source.kind === 'table' ? source.clause : `п. ${source.clause}`
  return `${documentLabel ?? source.documentCode}, ${place}`
}

/**
 * Правила из состояния параметров. Действует последнее подтверждённое значение; без него —
 * значение прототипа. `confirmed` истинно только для подтверждения по действующей редакции.
 */
export function rulesFrom(states: readonly ParameterState[] = []): NormativeRules {
  const byId = new Map(states.map((state) => [state.id, state]))
  const values: Record<string, ParameterValue | null> = {}
  const confirmed: Record<string, boolean> = {}
  const sources: Record<string, string> = {}
  for (const definition of parameterDefinitions) {
    const state = byId.get(definition.id)
    values[definition.id] = state?.confirmation?.value ?? fallbackValue(definition)
    confirmed[definition.id] = state?.status.kind === 'confirmed'
    sources[definition.id] = sourceLabel(
      definition,
      state?.confirmation?.documentLabel || state?.document?.label,
    )
  }
  const number = (id: string) => values[id] as number
  const table = (id: string) => values[id] as Record<string, string>
  /**
   * Строки таблицы по известным подписям. Составитель может переименовать строку при
   * подтверждении; тогда для неё действует значение прототипа.
   */
  const tableNumbers = <K extends string>(id: string, keys: Readonly<Record<K, string>>) => {
    const definition = parameterDefinition(id) as TableParameter
    const confirmedRows = table(id)
    return Object.fromEntries(
      (Object.entries(keys) as Array<[K, string]>).map(([field, key]) => [
        field,
        Number(confirmedRows[key] ?? definition.fallback[key]),
      ]),
    ) as Record<K, number>
  }
  return {
    signsHourly: number('odm-signs-hourly'),
    signsLengthMetres: number('odm-signs-length'),
    alternateHourly: number('odm-alternate-hourly'),
    signsTaperMetres: number('odm-signs-taper'),
    regulatorDistance: Object.fromEntries(
      Object.entries(table('odm-regulator-distance')).map(([speed, metres]) => [
        Number(speed),
        Number(metres),
      ]),
    ),
    speedStepKmh: number('gost-speed-step'),
    typesize: table('gost-sign-typesize'),
    allowedSpeedKmh: { in: number('pdd-speed-settlement'), out: number('pdd-speed-outside') },
    zoneSpeedKmh: number('odm-zone-speed'),
    signDistances: {
      ...tableNumbers('odm-sign-distances-outside', OUTSIDE_DISTANCE_KEYS),
      ...tableNumbers('gost-sign-distances-settlement', SETTLEMENT_DISTANCE_KEYS),
    },
    warningDistance: {
      in: range(table('gost-warning-distance')[WARNING_RANGE_KEYS.in]),
      out: range(table('gost-warning-distance')[WARNING_RANGE_KEYS.out]),
    },
    peakHourShare: (values['peak-hour-share'] as number | null) ?? null,
    confirmed,
    sources,
  }
}

/** «150–300» → [150, 300]; неразборчивое значение — null. */
function range(value: string | undefined): readonly [number, number] | null {
  const match = /^(\d+)\s*[–-]\s*(\d+)$/.exec(value?.trim() ?? '')
  if (!match) return null
  const low = Number(match[1])
  const high = Number(match[2])
  return low <= high ? [low, high] : null
}

/** Правила прототипа: ни один параметр не подтверждён. */
export const PROTOTYPE_RULES: NormativeRules = rulesFrom()

/** Параметры, от которых зависит подсказка способа пропуска. */
export const REGULATION_PARAMETERS = [
  'odm-signs-hourly',
  'odm-signs-length',
  'odm-alternate-hourly',
  'odm-signs-taper',
  'odm-regulator-distance',
] as const

export function regulationVerified(rules: NormativeRules): boolean {
  return REGULATION_PARAMETERS.every((id) => rules.confirmed[id])
}
