import type { Scheme } from './model'
import type { NormativeRules } from './normative-parameters'
import { cellNumber } from './pu66-norms'
import { shortTermWork, effectiveWorkSection, workTrafficDecision } from './work-traffic'
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
  const decision = workTrafficDecision(
    effectiveWorkSection(zone, conditions, scheme.template.code),
    parseHourly(regulation.hourly),
    regulation.vis,
    rules,
    conditions,
  )
  if (decision === 'signals' || decision === 'outside' || decision === 'unknown')
    problems.push(
      'Проверьте участок между устройствами, часовую интенсивность и условия замены светофора: выбранный профиль не поддерживает полученное сочетание (ГОСТ Р 58350, таблица Д.1).',
    )
  if (regulators && !conditions.regulatorsPresent)
    problems.push(
      'Подтвердите постоянное присутствие регулировщиков в течение всего срока работ (ОДМ, п. 6.4.3).',
    )
  if (scheme.template.code === 'b34' && regulation.mode === 'one') {
    if (conditions.daylight !== 'day' || !regulation.straight || regulation.vis)
      problems.push(
        'Для одного регулировщика требуется подтверждение светлого времени суток, прямого участка и видимости с обоих концов (ОДМ, п. 13.7.5).',
      )
    const section = effectiveWorkSection(zone, conditions)
    // The numerical boundary is a conservative project rule; ODM says “small length”.
    if (
      section === null ||
      section >= Math.min(rules.signsLengthMetres, rules.workTraffic.signsLength)
    )
      problems.push(
        'Небольшая протяжённость для одного регулировщика не подтверждена: в этом профиле выберите двух регулировщиков.',
      )
  }
  return problems
}
