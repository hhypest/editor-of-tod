/**
 * Объяснимая рекомендация способа пропуска транспорта для схемы Б.34 (ОДМ 218.6.019-2016).
 * Это подсказка составителю: она ничего не выбирает сама, а пункты и пороги требуют
 * предметной сверки с действующей редакцией ОДМ (docs/standards.md).
 */
export type RegulationMode = 'signs' | 'one' | 'two'

export type RegulationInput = {
  /** Часовая интенсивность в двух направлениях, как её ввёл составитель (фактический подсчёт). */
  hourly: string
  /** Видимость встречного автомобиля на участке ограничена. */
  limitedVisibility: boolean
  /** Прямой участок: регулировщик виден с обоих концов места работ. */
  straight: boolean
  /** Скорость в зоне работ (третья ступень), км/ч; null — не введена. */
  zoneSpeedKmh: number | null
  /** Отгон перед местом работ для Б.34, м; null — не введён. */
  taperMetres: number | null
}

export type RegulationAdvice = {
  mode: RegulationMode | null
  /** Принятая интенсивность, авт./ч, или null, если её нет. */
  hourly: number | null
  reasons: string[]
  warnings: string[]
  /** Расстояние от регулировщика до места работ по табл. 5 ОДМ, м; null — скорость вне таблицы. */
  regulatorDistanceMetres: number | null
}

/** ОДМ 218.6.019-2016, таблица 5: скорость в зоне, км/ч → расстояние регулировщика, м (сверить). */
export const REGULATOR_DISTANCE_BY_SPEED: Readonly<Record<number, number>> = {
  30: 10,
  40: 15,
  50: 30,
  60: 45,
  70: 65,
  80: 85,
}

const SIGNS_LIMIT = 250
const ALTERNATE_PASSAGE_LIMIT = 500

/** Разбор введённой интенсивности: только неотрицательное число, иначе «нет данных». */
export function parseHourly(value: string): number | null {
  const input = value.trim().replace(',', '.')
  if (!/^\d+(?:\.\d+)?$/.test(input)) return null
  const number = Number(input)
  return Number.isFinite(number) ? number : null
}

export function adviseRegulation(input: RegulationInput): RegulationAdvice {
  const hourly = parseHourly(input.hourly)
  const reasons: string[] = []
  const warnings: string[] = []
  let mode: RegulationMode | null

  if (hourly === null) {
    mode = null
    reasons.push(
      'Интенсивность не введена: без фактического часового подсчёта рекомендация не даётся. Коэффициент перевода суточной интенсивности в часовую не подставляется.',
    )
  } else if (hourly < SIGNS_LIMIT && !input.limitedVisibility) {
    mode = 'signs'
    reasons.push(
      `Интенсивность ${hourly} авт./ч в двух направлениях — менее ${SIGNS_LIMIT} авт./ч, видимость встречного автомобиля не ограничена: очерёдность можно установить знаками 2.6 и 2.7 (ОДМ, пп. 5.4.4, 8.1.3.1).`,
    )
  } else {
    const cause =
      hourly >= SIGNS_LIMIT
        ? `интенсивность ${hourly} авт./ч — ${SIGNS_LIMIT} авт./ч и более`
        : 'видимость встречного автомобиля ограничена'
    if (input.straight && !input.limitedVisibility) {
      mode = 'one'
      reasons.push(
        `Знаки 2.6/2.7 не подходят: ${cause} (ОДМ, пп. 5.4.4, 8.1.3.1). Участок прямой, регулировщик виден с обоих концов места работ — возможен один регулировщик (ОДМ, п. 12.7.3).`,
      )
    } else {
      mode = 'two'
      reasons.push(
        `Знаки 2.6/2.7 не подходят: ${cause} (ОДМ, пп. 5.4.4, 8.1.3.1). ${
          input.limitedVisibility
            ? 'При ограниченной видимости'
            : 'Участок не отмечен как прямой, и'
        } один регулировщик не виден с обоих концов места работ — нужны два регулировщика у начала и конца (ОДМ, пп. 12.7.2–12.7.3).`,
      )
    }
  }

  if (hourly !== null && hourly > ALTERNATE_PASSAGE_LIMIT)
    warnings.push(
      `Интенсивность выше ${ALTERNATE_PASSAGE_LIMIT} авт./ч — верхней границы поочерёдного пропуска по одной полосе (ОДМ, п. 5.4.2). Проверьте допустимость такого пропуска, время работ и другие способы организации движения; число регулировщиков из этого порога не выводится.`,
    )
  if (mode === 'signs' && input.taperMetres !== 15)
    warnings.push(
      `Для знаков 2.6/2.7 черновая сборка требует отгон 15 м (ОДМ, п. 4.1.8.3); сейчас ${
        input.taperMetres === null ? 'он не введён' : `${input.taperMetres} м`
      }.`,
    )

  const regulatorDistanceMetres =
    mode !== 'signs' && input.zoneSpeedKmh !== null
      ? (REGULATOR_DISTANCE_BY_SPEED[input.zoneSpeedKmh] ?? null)
      : null
  if (mode && mode !== 'signs')
    reasons.push(
      regulatorDistanceMetres === null
        ? 'Расстояние от регулировщика до места работ по таблице 5 ОДМ для введённой скорости не определено — уточните по документу.'
        : `Регулировщик — не ближе ${regulatorDistanceMetres} м до места работ при скорости ${input.zoneSpeedKmh} км/ч (ОДМ, табл. 5; значение сверить с документом).`,
    )

  return { mode, hourly, reasons, warnings, regulatorDistanceMetres }
}

export const regulationModeLabels: Record<RegulationMode, string> = {
  signs: 'знаки приоритета 2.6/2.7',
  one: 'один регулировщик',
  two: 'два регулировщика',
}
