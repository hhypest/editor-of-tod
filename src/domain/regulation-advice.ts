import {
  PROTOTYPE_RULES,
  REGULATION_PARAMETERS,
  parameterDefinition,
  regulationVerified,
  type NormativeRules,
} from './normative-parameters.ts'
import { workTrafficDecision, shortTermWork, type WorkConditions } from './work-traffic.ts'

/**
 * Объяснимая подсказка способа пропуска транспорта для схемы Б.34. Пороги, протяжённость,
 * отгон и таблица расстояний берутся из нормативных параметров («Реестры» → «Нормативные
 * параметры»): составитель подтверждает их по тексту действующих редакций ОДМ 218.6.019 и ГОСТ Р 58350.
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
  /** Полная протяжённость участка между первым и последним устройствами. */
  sectionMetres: number | null
  workConditions?: WorkConditions
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
  if (!shortTermWork(input.workConditions, rules))
    warnings.push(
      `Укажите краткосрочные работы и продолжительность не более ${rules.shortTermHours} ч; без этих условий подсказку применять нельзя (${rules.sources['gost-short-term-hours']}).`,
    )
  const signsSource = rules.sources['odm-signs-hourly']
  let mode: RegulationMode | null

  const section = input.sectionMetres
  const length = Math.min(rules.signsLengthMetres, rules.workTraffic.signsLength)
  const intensity = Math.min(rules.signsHourly, rules.workTraffic.signsHourly)
  const source = rules.sources['gost-work-traffic']
  const decision = workTrafficDecision(
    section,
    hourly,
    input.limitedVisibility,
    rules,
    input.workConditions,
  )
  if (decision === 'unknown') {
    mode = null
    reasons.push(
      hourly === null
        ? 'Интенсивность не введена: нужна часовая интенсивность в двух направлениях. Пересчёт из ПУ-66 допустим только с подтверждённой долей часа пик.'
        : 'Протяжённость участка проведения работ не введена: нужны отгон, буфер и фронт. Один фронт не определяет участок между первым и последним направляющим или ограждающим устройством.',
    )
  } else if (decision === 'outside' || decision === 'signals') {
    mode = null
    reasons.push(
      decision === 'signals'
        ? `Протяжённость участка проведения работ ${section} м — ${length} м и более при интенсивности менее ${intensity} авт./ч: таблица предусматривает светофор. Автоматический выбор одного или двух регулировщиков не даётся (${source}; ОДМ, пп. 6.4.2–6.4.3).`
        : `Сочетание протяжённости ${section} м и интенсивности ${hourly} авт./ч выходит за условия таблицы. Требуется отдельное решение по организации движения (${source}; ОДМ, п. 6.4.5).`,
    )
    warnings.push(
      `Число регулировщиков из одного порога интенсивности не выводится (${source}; ${rules.sources['odm-alternate-hourly']}).`,
    )
  } else if (decision === 'signs') {
    mode = 'signs'
    reasons.push(
      `Интенсивность ${hourly} авт./ч в двух направлениях — менее ${intensity} авт./ч, участок проведения работ ${section} м — менее ${length} м, видимость встречного автомобиля обеспечена с обеих сторон: допускаются знаки 2.6 и 2.7 (${signsSource}; ${source}).`,
    )
  } else {
    mode =
      input.straight &&
      !input.limitedVisibility &&
      section !== null &&
      section < length &&
      input.workConditions?.daylight === 'day' &&
      shortTermWork(input.workConditions, rules) &&
      input.workConditions.regulatorsPresent &&
      input.zoneSpeedKmh !== null
        ? 'one'
        : 'two'
    reasons.push(
      `Знаки 2.6/2.7 не подходят по интенсивности или видимости. Допускаются регулировщики при их постоянном присутствии в течение всего срока работ (${source}; ОДМ, п. 6.4.3).`,
    )
    reasons.push(
      mode === 'one'
        ? 'Один регулировщик возможен после проверки небольшой протяжённости рабочей зоны, прямого участка, видимости регулировщика с обоих концов, светлого времени суток и введённых ограничений скорости (ОДМ 218.6.019, п. 13.7.5).'
        : 'Два регулировщика размещаются у начала и конца места работ; необходимы согласованные действия и связь (ОДМ 218.6.019, пп. 13.7.3–13.7.5).',
    )
    warnings.push(
      'Видимость встречного автомобиля и видимость регулировщика проверяются отдельно. Для одного регулировщика дополнительно проверьте светлое время суток и все условия п. 13.7.5; для замены светофора — постоянное присутствие (п. 6.4.3).',
    )
  }
  if (section !== null)
    reasons.push(
      `Протяжённость участка — ${section} м (${input.workConditions?.sectionMetres !== null && input.workConditions?.sectionMetres !== undefined ? 'измеренные границы устройств' : `предварительно: отгон + буфер + фронт ${input.frontMetres ?? 'не введён'} м`}). Сверьте фактические границы направляющих устройств и расстояние видимости встречного автомобиля по ГОСТ Р 52289.`,
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
    verified:
      (section === null || input.frontMetres === null || section >= input.frontMetres) &&
      regulationVerified(rules) &&
      shortTermWork(input.workConditions, rules) &&
      (mode === 'signs' || input.workConditions?.regulatorsPresent === true),
    unconfirmed,
  }
}

export const regulationModeLabels: Record<RegulationMode, string> = {
  signs: 'знаки приоритета 2.6/2.7',
  one: 'один регулировщик',
  two: 'два регулировщика',
}
