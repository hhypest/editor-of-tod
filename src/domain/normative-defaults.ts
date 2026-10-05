import type { Scheme } from './model'
import {
  OUTSIDE_DISTANCE_KEYS,
  SETTLEMENT_DISTANCE_KEYS,
  type NormativeRules,
} from './normative-parameters'

/**
 * Значения по умолчанию для расстояний до знаков и ступеней скорости. Программа подставляет
 * их из нормативных параметров, а составитель может исправить любое значение под местные
 * условия. Отметка «по нормативу» не хранится: значение сравнивается с нормативным при
 * каждом показе, поэтому после подтверждения параметра в другой редакции отличие видно сразу.
 */

export type SchemeLocation = 'in' | 'out'
type Parameters = Scheme['parameters']
/** Поля параметров, от которых зависят значения по умолчанию. */
export type DefaultsFields = Pick<
  Parameters,
  'location' | 'approachSpeedKmh' | 'signDistancesMetres' | 'speedStagesKmh' | 'signSize'
>
type SignSize = Parameters['signSize']

/**
 * Строка таблицы 1 ГОСТ Р 52289 для схем Б.33/Б.34: они строятся для дороги с двумя полосами
 * (одна закрыта, движение по другой), поэтому вне населённого пункта это «две и три полосы».
 */
export const TWO_LANE_TYPESIZE_ROW = 'две и три полосы'
export type DistanceField = keyof Parameters['signDistancesMetres']

/** Поля расстояний, которые использует раскладка для каждого местоположения. */
export const distanceFields: Readonly<Record<SchemeLocation, readonly DistanceField[]>> = {
  out: ['d300', 'd250', 'd150', 'd50'],
  in: ['n100', 'n50'],
}

/**
 * Понятные подписи полей; маркер ({d300}) остаётся в подписях стоек на листе. Совпадают со
 * строками таблиц нормативных параметров, чтобы составитель видел одни и те же названия.
 */
export const distanceTitles: Readonly<Record<DistanceField, string>> = {
  ...OUTSIDE_DISTANCE_KEYS,
  ...SETTLEMENT_DISTANCE_KEYS,
}

export const speedTitles = ['Первая ступень', 'Вторая ступень', 'Скорость в зоне работ'] as const

export function distanceSource(field: DistanceField, rules: NormativeRules): string {
  return distanceFields.out.includes(field)
    ? rules.sources['odm-sign-distances-outside']!
    : rules.sources['gost-sign-distances-settlement']!
}

export function approachSource(location: SchemeLocation, rules: NormativeRules): string {
  const source = rules.sources[location === 'in' ? 'pdd-speed-settlement' : 'pdd-speed-outside']!
  return location === 'out'
    ? `${source}; только легковые, мотоциклы и грузовые до 3,5 т на остальных дорогах`
    : `${source}; общий предел, кроме жилых/велосипедных зон и дворов`
}

/**
 * Типоразмер знаков по таблице 1 ГОСТ Р 52289 (п. 5.1.16): вне населённого пункта — строка
 * двухполосной дороги (II). В населённом пункте типоразмер зависит от класса улицы, которого в
 * проекте нет, — null, выбирает составитель.
 */
export function expectedTypesize(location: SchemeLocation, rules: NormativeRules): SignSize | null {
  if (location === 'in') return null
  const value = rules.typesize[TWO_LANE_TYPESIZE_ROW] ?? 'II'
  return value === 'I' || value === 'II' || value === 'III' || value === 'IV' ? value : 'II'
}

export function typesizeSource(rules: NormativeRules): string {
  return `${rules.sources['gost-sign-typesize']}, дорога с двумя и тремя полосами вне населённого пункта`
}

/** Типоразмер при смене местоположения: значение по умолчанию прежнего варианта заменяется. */
function switchTypesize(current: SignSize, to: SchemeLocation, rules: NormativeRules): SignSize {
  const outside = expectedTypesize('out', rules)
  if (to === 'out') return current === 'auto' ? outside! : current
  return current === outside ? 'auto' : current
}

export function defaultApproachSpeed(location: SchemeLocation, rules: NormativeRules): number {
  return rules.allowedSpeedKmh[location]
}

/**
 * Ступени 3.24 по умолчанию от разрешённой скорости на подходе: каждая ниже предыдущей на
 * наибольший шаг ступенчатого ограничения (ГОСТ Р 52289, п. 5.4.22), но не ниже скорости в
 * зоне работ. При 90 км/ч и шаге 20 получается 70 → 50 → 40, как на рисунках Б.33 и Б.34.
 */
export function defaultSpeedStages(
  approachKmh: number,
  rules: NormativeRules,
): [number, number, number] {
  const zone = rules.zoneSpeedKmh
  const first = Math.max(zone, approachKmh - rules.speedStepKmh)
  const second = Math.max(zone, first - rules.speedStepKmh)
  return [first, second, zone]
}

function sameStages(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index])
}

/** Пустые расстояния выбранного местоположения заполняются нормативными; введённые не меняются. */
export function fillDistanceDefaults(
  distances: Parameters['signDistancesMetres'],
  location: SchemeLocation,
  rules: NormativeRules,
): Parameters['signDistancesMetres'] {
  const result = { ...distances }
  for (const field of distanceFields[location]) result[field] ??= rules.signDistances[field]
  return result
}

/** «Вернуть нормативные значения»: все расстояния местоположения, скорость и ступени. */
export function resetToNormative<T extends DefaultsFields>(
  parameters: T,
  rules: NormativeRules,
): T {
  const { location } = parameters
  if (location === 'auto') return parameters
  const distances = { ...parameters.signDistancesMetres }
  for (const field of distanceFields[location]) distances[field] = rules.signDistances[field]
  const approach = defaultApproachSpeed(location, rules)
  return {
    ...parameters,
    approachSpeedKmh: approach,
    signDistancesMetres: distances,
    speedStagesKmh: defaultSpeedStages(approach, rules),
    signSize: expectedTypesize(location, rules) ?? parameters.signSize,
  }
}

/**
 * Смена местоположения. Расстояния у вариантов разные (d… и n…), поэтому заполняются только
 * пустые поля нового варианта. Разрешённая скорость меняется, если она пуста или равна
 * значению по умолчанию прежнего варианта; ступени — если они совпадают с расчётными от
 * прежней скорости. Исправленные составителем значения сохраняются и помечаются в форме.
 */
export function switchLocation<T extends DefaultsFields>(
  parameters: T,
  to: SchemeLocation,
  rules: NormativeRules,
): T {
  const from = parameters.location
  if (from === to) return parameters
  // «Не определено» до v7 означало скорость в населённом пункте.
  const previousDefault = defaultApproachSpeed(from === 'out' ? 'out' : 'in', rules)
  const approach =
    parameters.approachSpeedKmh === null || parameters.approachSpeedKmh === previousDefault
      ? defaultApproachSpeed(to, rules)
      : parameters.approachSpeedKmh
  const stagesWereDefault =
    parameters.approachSpeedKmh === null ||
    sameStages(parameters.speedStagesKmh, defaultSpeedStages(parameters.approachSpeedKmh, rules))
  return {
    ...parameters,
    location: to,
    approachSpeedKmh: approach,
    signDistancesMetres: fillDistanceDefaults(parameters.signDistancesMetres, to, rules),
    speedStagesKmh: stagesWereDefault
      ? defaultSpeedStages(approach, rules)
      : parameters.speedStagesKmh,
    signSize: switchTypesize(parameters.signSize, to, rules),
  }
}

/**
 * Смена разрешённой скорости: ступени пересчитываются, только если совпадали с расчётными
 * от прежней скорости.
 */
export function changeApproachSpeed<T extends DefaultsFields>(
  parameters: T,
  approachKmh: number | null,
  rules: NormativeRules,
): T {
  const previous = parameters.approachSpeedKmh
  const stagesWereDefault =
    previous === null || sameStages(parameters.speedStagesKmh, defaultSpeedStages(previous, rules))
  return {
    ...parameters,
    approachSpeedKmh: approachKmh,
    speedStagesKmh:
      stagesWereDefault && approachKmh !== null
        ? defaultSpeedStages(approachKmh, rules)
        : parameters.speedStagesKmh,
  }
}

export type NormativeMark = {
  /** Путь поля формы (`data-field`). */
  field: string
  title: string
  value: number | string | null
  normative: number | string
  source: string
  state: 'normative' | 'changed' | 'empty'
}

/**
 * Сверка значений с нормативными по умолчанию для всех полей, которые использует раскладка
 * выбранного местоположения. Для населённого пункта промежуточные ступени строятся сами,
 * поэтому сверяется только скорость в зоне работ.
 */
export function normativeMarks(parameters: DefaultsFields, rules: NormativeRules): NormativeMark[] {
  const { location } = parameters
  if (location === 'auto') return []
  const result: NormativeMark[] = []
  const mark = (item: Omit<NormativeMark, 'state'>) =>
    result.push({
      ...item,
      state:
        item.value === null || Number.isNaN(item.value)
          ? 'empty'
          : item.value === item.normative
            ? 'normative'
            : 'changed',
    })
  for (const field of distanceFields[location]) {
    mark({
      field: `parameters.signDistancesMetres.${field}`,
      title: `расстояние «${distanceTitles[field]}»`,
      value: parameters.signDistancesMetres[field],
      normative: rules.signDistances[field],
      source: distanceSource(field, rules),
    })
  }
  const allowed = defaultApproachSpeed(location, rules)
  mark({
    field: 'parameters.approachSpeedKmh',
    title: 'разрешённая скорость на подходе',
    value: parameters.approachSpeedKmh,
    normative: allowed,
    source: approachSource(location, rules),
  })
  const stages = defaultSpeedStages(parameters.approachSpeedKmh ?? allowed, rules)
  for (const index of location === 'out' ? [0, 1, 2] : [2]) {
    mark({
      field: `parameters.speedStagesKmh.${index}`,
      title: speedTitles[index]!.toLowerCase(),
      value: parameters.speedStagesKmh[index]!,
      normative: stages[index]!,
      source:
        index === 2
          ? rules.sources['odm-zone-speed']!
          : `шаг ${rules.speedStepKmh} км/ч от разрешённой скорости, ${rules.sources['gost-speed-step']}`,
    })
  }
  const typesize = expectedTypesize(location, rules)
  if (typesize) {
    mark({
      field: 'parameters.signSize',
      title: 'типоразмер знаков',
      value: parameters.signSize === 'auto' ? null : parameters.signSize,
      normative: typesize,
      source: typesizeSource(rules),
    })
  }
  return result
}

/** Значения, которые отличаются от нормативных по умолчанию или не заполнены. */
export function normativeDeviations(
  parameters: DefaultsFields,
  rules: NormativeRules,
): NormativeMark[] {
  return normativeMarks(parameters, rules).filter((item) => item.state !== 'normative')
}

/** Параметры, из которых берутся значения по умолчанию для местоположения. */
export function defaultsParameterIds(location: SchemeLocation): string[] {
  return location === 'out'
    ? [
        'odm-sign-distances-outside',
        'pdd-speed-outside',
        'odm-zone-speed',
        'gost-speed-step',
        'gost-sign-typesize',
      ]
    : [
        'gost-sign-distances-settlement',
        'pdd-speed-settlement',
        'odm-zone-speed',
        'gost-speed-step',
      ]
}

/**
 * Расстояние до предупреждающего знака 1.25 вне диапазона ГОСТ Р 52289, п. 5.2.2. Иное
 * расстояние допускается, но указывается табличкой 8.1.1.
 */
export function warningDistanceProblem(
  parameters: DefaultsFields,
  rules: NormativeRules,
): { value: number; range: readonly [number, number]; source: string } | null {
  const { location } = parameters
  if (location === 'auto') return null
  const range = rules.warningDistance[location]
  const value = parameters.signDistancesMetres[location === 'out' ? 'd300' : 'n100']
  if (!range || value === null) return null
  if (value >= range[0] && value <= range[1]) return null
  return { value, range, source: rules.sources['gost-warning-distance']! }
}

/** Наибольший перепад между соседними ступенями вне населённого пункта (п. 5.4.22). */
export function largestSpeedStep(parameters: DefaultsFields): number | null {
  if (parameters.location !== 'out' || parameters.approachSpeedKmh === null) return null
  const sequence = [parameters.approachSpeedKmh, ...parameters.speedStagesKmh]
  let largest = 0
  for (let index = 1; index < sequence.length; index++) {
    largest = Math.max(largest, sequence[index - 1]! - sequence[index]!)
  }
  return largest
}
