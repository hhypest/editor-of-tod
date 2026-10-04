import {
  PROTOTYPE_RULES,
  REGULATION_PARAMETERS,
  parameterDefinition,
  regulationVerified,
  type NormativeRules,
} from './normative-parameters.ts'
import { workTrafficDecision, shortTermWork, type WorkConditions } from './work-traffic.ts'
import { railRegulationMode } from './rail-regulation.ts'
import { selectTemplateByWorkFront } from './registry.ts'

/**
 * Объяснимая подсказка способа пропуска транспорта для схемы Б.34. Пороги, протяжённость,
 * отгон и таблица расстояний берутся из нормативных параметров («Реестры» → «Нормативные
 * параметры»): нормативные условия подтверждаются по текстам ОДМ и ГОСТ, профиль переезда —
 * отдельным решением специалиста с основанием.
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
  const section = input.sectionMetres
  const mode = railRegulationMode(
    {
      variant:
        input.frontMetres === null ? 'b34' : selectTemplateByWorkFront(input.frontMetres).code,
      frontMetres: input.frontMetres,
      hourly,
      limitedVisibility: input.limitedVisibility,
      straight: input.straight,
      daylight: input.workConditions?.daylight ?? 'unknown',
    },
    rules,
  )
  const {
    signsHourlyInclusive: signs,
    oneHourlyInclusive: one,
    frontMaximumMetres: maximum,
  } = rules.railProfile
  reasons.push(
    `Профиль железнодорожного переезда — решение специалиста: при нормальной видимости до ${signs} авт./ч включительно — знаки, свыше ${signs} до ${one} включительно — один регулировщик, свыше ${one} — два. При ограниченной видимости всегда два; Б.33 всегда два. Максимум фронта ${maximum} м. Профиль подтверждается отдельно от таблицы Д.1 ГОСТ Р 58350.`,
  )
  if (mode === null) {
    reasons.push(
      hourly === null
        ? 'Интенсивность не введена: нужна часовая интенсивность в двух направлениях. Пересчёт из ПУ-66 допустим только с подтверждённой долей часа пик.'
        : `Проверьте фронт работ: он должен быть положительным и не превышать ${maximum} м. Участок между устройствами проверяется отдельно.`,
    )
  } else if (mode === 'signs') {
    reasons.push(
      `Интенсивность ${hourly} авт./ч — до ${signs} включительно, видимость встречного автомобиля обеспечена: профиль предлагает знаки 2.6 и 2.7 (решение специалиста). Нормативное основание знаков проверяется отдельно: ${rules.sources['odm-signs-hourly']}; ${rules.sources['gost-work-traffic']}.`,
    )
  } else {
    reasons.push(
      mode === 'one'
        ? 'Один регулировщик: дневные работы, прямой участок и видимость с обоих концов. Проверьте все условия ОДМ 218.6.019, п. 13.7.5; требуется постоянное присутствие (п. 6.4.3).'
        : 'Два регулировщика размещаются у начала и конца места работ; необходимы согласованные действия, связь и постоянное присутствие (ОДМ 218.6.019, пп. 13.7.3–13.7.5, п. 6.4.3).',
    )
    if (!input.workConditions?.regulatorsPresent)
      warnings.push(
        'Подтвердите постоянное присутствие регулировщиков в течение всего срока работ.',
      )
    if (
      hourly !== null &&
      hourly > signs &&
      hourly <= one &&
      (input.workConditions?.daylight !== 'day' || !input.straight)
    )
      warnings.push(
        'Для одного регулировщика не подтверждены дневные работы или прямой участок: профиль предлагает двух.',
      )
  }
  const normative = workTrafficDecision(
    section,
    hourly,
    input.limitedVisibility,
    rules,
    input.workConditions,
  )
  if (
    normative === 'outside' ||
    normative === 'unknown' ||
    (mode === 'signs' && normative !== 'signs')
  )
    warnings.push(
      `Принятый профиль требует отдельного обоснования по фактической длине участка и интенсивности. Таблица Д.1 использует строгий порог «менее ${Math.min(rules.signsHourly, rules.workTraffic.signsHourly)} авт./ч» и сочетания длины/потока; её значения не задают количество регулировщиков. Сверьте решение специалиста с действующим текстом (${rules.sources['gost-work-traffic']}).`,
    )
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
      mode !== null &&
      section !== null &&
      input.frontMetres !== null &&
      section >= input.frontMetres &&
      (mode === 'signs' || regulatorDistanceMetres !== null) &&
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
