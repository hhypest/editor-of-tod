import { CROSSING_FRONT_LIMIT_METRES } from './crossing-limits'
import type { Scheme } from './model'
import type { NormativeRules } from './normative-parameters'
import { cellNumber } from './pu66-norms'
import { shortTermWork, effectiveWorkSection } from './work-traffic'
import { railRegulationMode } from './rail-regulation'
import { parseHourly } from './regulation-advice'

export function frontLimit(scheme: Scheme): number | null {
  return scheme.crossing.source === 'local-pu66'
    ? cellNumber(scheme.crossing.snapshot.crossingRoadLengthMetres)
    : null
}

/** The same explicit conditions govern template building and manual acceptance. */
export function workConditionProblems(scheme: Scheme, rules: NormativeRules): string[] {
  const { workConditions: conditions, regulation } = scheme.parameters
  const zone = scheme.parameters.workZones[scheme.template.code]
  const problems: string[] = []
  if (zone && conditions.sectionMetres !== null && conditions.sectionMetres < zone.workMetres)
    problems.push(
      'Участок между устройствами не может быть короче фронта работ. Проверьте измеренные границы.',
    )
  if (!shortTermWork(conditions, rules))
    problems.push(
      `Б.33/Б.34: укажите краткосрочные работы и продолжительность не более ${rules.shortTermHours} ч (${rules.sources['gost-short-term-hours']}).`,
    )
  if (zone && zone.workMetres > CROSSING_FRONT_LIMIT_METRES)
    problems.push(
      `Фронт ${zone.workMetres} м превышает предел фронта редактора ${CROSSING_FRONT_LIMIT_METRES} м. Отгон и буфер проверяются отдельно.`,
    )
  const maximum = frontLimit(scheme)
  if (scheme.crossing.source === 'local-pu66' && (maximum === null || maximum <= 0))
    problems.push(
      'В закреплённой карточке отсутствует положительная длина проезжей части в границах переезда (п. 8 ПУ-66). Заполните карточку и явно обновите её связь с проектом.',
    )
  if (maximum !== null && zone && zone.workMetres > maximum)
    problems.push(
      `Фронт ${zone.workMetres} м превышает длину в границах переезда ${maximum} м из п. 8 ПУ-66. Отгон и буфер в этот фронт не входят.`,
    )
  const regulators =
    scheme.template.code === 'b33' || regulation.mode === 'one' || regulation.mode === 'two'
  const expected = railRegulationMode(
    {
      variant: scheme.template.code,
      frontMetres: zone?.workMetres ?? null,
      sectionMetres: effectiveWorkSection(zone, conditions, scheme.template.code),
      hourly: parseHourly(regulation.hourly),
      limitedVisibility: regulation.vis,
      straight: regulation.straight,
      daylight: conditions.daylight,
    },
    rules,
  )
  if (expected === null)
    problems.push(
      'Проверьте фронт, длину участка между устройствами и часовую интенсивность в двух направлениях.',
    )
  if (scheme.template.code === 'b34') {
    if (
      regulation.mode === 'auto' ||
      (regulation.mode === 'signs' && expected !== 'signs') ||
      (regulation.mode === 'one' &&
        (regulation.vis ||
          (parseHourly(regulation.hourly) ?? Infinity) >
            Math.min(rules.alternateHourly, rules.workTraffic.alternateHourly)))
    )
      problems.push(
        'Выбранный режим не соответствует условиям Б.34: при ограниченной видимости или потоке свыше верхней границы нужны два регулировщика; знаки допускаются только при обеспеченной видимости, потоке менее нормативной границы и участке между устройствами менее нормативной длины. Для одного требуется подтверждение светлого времени суток и прямого участка.',
      )
  }
  if (regulators && !conditions.regulatorsPresent)
    problems.push(
      'Подтвердите постоянное присутствие регулировщиков в течение всего срока работ (ОДМ, п. 6.4.3).',
    )
  if (scheme.template.code === 'b34' && regulation.mode === 'one') {
    if (conditions.daylight !== 'day' || !regulation.straight || regulation.vis)
      problems.push(
        'Для одного регулировщика требуется подтверждение светлого времени суток, прямого участка и видимости с обоих концов (ОДМ, п. 13.7.5).',
      )
  }
  return problems
}
