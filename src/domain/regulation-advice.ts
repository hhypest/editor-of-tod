import {
  PROTOTYPE_RULES,
  REGULATION_PARAMETERS,
  parameterDefinition,
  regulationVerified,
  type NormativeRules,
} from './normative-parameters.ts'

/**
 * Объяснимая подсказка способа пропуска транспорта для схемы Б.34. Пороги, протяжённость,
 * отгон и таблица расстояний берутся из нормативных параметров («Реестры» → «Нормативные
 * параметры»): составитель подтверждает их по тексту действующей редакции ОДМ 218.6.019.
 * Пока хотя бы один параметр не подтверждён, подсказка только объясняет расчёт и не
 * применяется из интерфейса.
 */
export type RegulationMode = 'signs' | 'one' | 'two'

export type RegulationInput = {
  /** Часовая интенсивность в двух направлениях, как её ввёл составитель. */
  hourly: string
  /** Видимость встречного автомобиля на участке ограничена. */
  limitedVisibility: boolean
  /** Прямой участок: регулировщик виден с обоих концов места работ. */
  straight: boolean
  /** Скорость в зоне работ (третья ступень), км/ч; null — не введена. */
  zoneSpeedKmh: number | null
  /** Отгон перед местом работ для Б.34, м; null — не введён. */
  taperMetres: number | null
  /** Протяжённость участка работ (фронт), м; null — не введена. */
  frontMetres: number | null
}

export type RegulationAdvice = {
  mode: RegulationMode | null
  /** Принятая интенсивность, авт./ч, или null, если её нет. */
  hourly: number | null
  reasons: string[]
  warnings: string[]
  /** Расстояние от регулировщика до начала рабочей зоны по таблице, м; null — скорость вне таблицы. */
  regulatorDistanceMetres: number | null
  /** Все параметры подсказки подтверждены по действующей редакции: её можно применять. */
  verified: boolean
  /** Названия неподтверждённых параметров. */
  unconfirmed: string[]
}

/** Разбор введённой интенсивности: только неотрицательное число, иначе «нет данных». */
export function parseHourly(value: string): number | null {
  const input = value.trim().replace(',', '.')
  if (!/^\d+(?:\.\d+)?$/.test(input)) return null
  const number = Number(input)
  return Number.isFinite(number) ? number : null
}

export function adviseRegulation(
  input: RegulationInput,
  rules: NormativeRules = PROTOTYPE_RULES,
): RegulationAdvice {
  const hourly = parseHourly(input.hourly)
  const reasons: string[] = []
  const warnings: string[] = []
  const signsSource = rules.sources['odm-signs-hourly']
  let mode: RegulationMode | null

  const tooLong =
    input.frontMetres !== null && input.frontMetres >= rules.signsLengthMetres
      ? `протяжённость участка работ ${input.frontMetres} м — ${rules.signsLengthMetres} м и более`
      : null
  if (hourly === null) {
    mode = null
    reasons.push(
      'Интенсивность не введена: без часовой интенсивности рекомендация не даётся. Её можно подсчитать или пересчитать из суточной по ПУ-66 с подтверждённой долей часа пик.',
    )
  } else if (
    hourly < rules.signsHourly &&
    !input.limitedVisibility &&
    !tooLong &&
    input.frontMetres === null
  ) {
    // Знаки допускаются только при участке короче предела: без длины рекомендации нет.
    mode = null
    reasons.push(
      `Интенсивность ${hourly} авт./ч — менее ${rules.signsHourly} авт./ч, но протяжённость участка работ не введена: знаки 2.6 и 2.7 допускаются только при участке менее ${rules.signsLengthMetres} м (${rules.sources['odm-signs-length']}). Укажите длину рабочей зоны.`,
    )
  } else if (hourly < rules.signsHourly && !input.limitedVisibility && !tooLong) {
    mode = 'signs'
    reasons.push(
      `Интенсивность ${hourly} авт./ч в двух направлениях — менее ${rules.signsHourly} авт./ч, участок ${input.frontMetres} м — менее ${rules.signsLengthMetres} м, видимость встречного автомобиля не ограничена: очерёдность можно установить знаками 2.6 и 2.7 (${signsSource}).`,
    )
  } else {
    const cause =
      hourly >= rules.signsHourly
        ? `интенсивность ${hourly} авт./ч — ${rules.signsHourly} авт./ч и более`
        : (tooLong ?? 'видимость встречного автомобиля ограничена')
    if (input.straight && !input.limitedVisibility) {
      mode = 'one'
      reasons.push(
        `Знаки 2.6/2.7 не подходят: ${cause} (${signsSource}). Участок прямой, регулировщик виден с обоих концов места работ — возможен один регулировщик (ОДМ 218.6.019, п. 12.7.3).`,
      )
    } else {
      mode = 'two'
      reasons.push(
        `Знаки 2.6/2.7 не подходят: ${cause} (${signsSource}). ${
          input.limitedVisibility
            ? 'При ограниченной видимости'
            : 'Участок не отмечен как прямой, и'
        } один регулировщик не виден с обоих концов места работ — нужны два регулировщика у начала и конца (ОДМ 218.6.019, пп. 12.7.2–12.7.3).`,
      )
    }
  }

  if (hourly !== null && hourly > rules.alternateHourly)
    warnings.push(
      `Интенсивность выше ${rules.alternateHourly} авт./ч — верхней границы поочерёдного пропуска по одной полосе (${rules.sources['odm-alternate-hourly']}). Проверьте допустимость такого пропуска, время работ и другие способы организации движения; число регулировщиков из этого порога не выводится.`,
    )
  if (mode === 'signs' && input.taperMetres !== rules.signsTaperMetres)
    warnings.push(
      `Для знаков 2.6/2.7 отгон ${rules.signsTaperMetres} м (${rules.sources['odm-signs-taper']}); сейчас ${
        input.taperMetres === null ? 'он не введён' : `${input.taperMetres} м`
      }.`,
    )

  const regulatorDistanceMetres =
    mode !== 'signs' && input.zoneSpeedKmh !== null
      ? (rules.regulatorDistance[input.zoneSpeedKmh] ?? null)
      : null
  if (mode && mode !== 'signs')
    reasons.push(
      regulatorDistanceMetres === null
        ? `Расстояние от регулировщика до начала рабочей зоны для введённой скорости в таблице не задано — уточните (${rules.sources['odm-regulator-distance']}).`
        : `Регулировщик — на расстоянии ${regulatorDistanceMetres} м до начала рабочей зоны при скорости ${input.zoneSpeedKmh} км/ч (${rules.sources['odm-regulator-distance']}).`,
    )

  const unconfirmed = REGULATION_PARAMETERS.filter((id) => !rules.confirmed[id]).map(
    (id) => parameterDefinition(id)!.title,
  )
  return {
    mode,
    hourly,
    reasons,
    warnings,
    regulatorDistanceMetres,
    verified: regulationVerified(rules),
    unconfirmed,
  }
}

export const regulationModeLabels: Record<RegulationMode, string> = {
  signs: 'знаки приоритета 2.6/2.7',
  one: 'один регулировщик',
  two: 'два регулировщика',
}
