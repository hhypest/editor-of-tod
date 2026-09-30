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
    peakHourShare: (values['peak-hour-share'] as number | null) ?? null,
    confirmed,
    sources,
  }
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
