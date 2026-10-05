import type { Scheme } from './model'
import type { NormativeRules } from './normative-parameters'

/** Предметные проверки ПДД. Не выводим безопасность переезда из условных координат SVG. */
export function pddFindings(scheme: Scheme, rules: NormativeRules) {
  const { parameters, placements } = scheme
  const evidence = Object.keys(rules.evidence)
    .filter((id) => id.startsWith('pdd-'))
    .sort()
    .map((id) => [id, rules.evidence[id]])
  const edition = rules.pddDocument?.label ?? 'ПДД: действующая редакция не определена в библиотеке'
  const basis = (data: unknown) =>
    JSON.stringify(['pdd-review-v1', rules.pddDocument, evidence, data])
  const checks = [
    {
      id: 'pdd-speed',
      kind: 'verify' as const,
      title: 'Скорость по условиям ПДД',
      detail: `${edition}, пп. 10.1–10.5. Проверьте скорость на подходе для фактического вида дороги, состава потока и действующих знаков. Предварительная подстановка вне населённого пункта относится только к легковым, мотоциклам и грузовым до 3,5 т на остальных дорогах. Другие ТС, прицеп, буксировка ТС, перевозка людей/детей и особые зоны имеют отдельные пределы. Повышение скорости требует предусмотренного Правилами решения и знаков; один выбор местоположения его не подтверждает.`,
      path: 'parameters.approachSpeedKmh',
      basis: basis([
        parameters.location,
        parameters.approachSpeedKmh,
        parameters.speedStagesKmh,
        placements.filter((item) => item.kind === 'sign-post'),
        parameters.speedConditions,
        scheme.decisionEvidence.speed,
      ]),
    },
    {
      id: 'pdd-crossing',
      kind: 'verify' as const,
      title: 'Пропуск через железнодорожный переезд по ПДД',
      detail: `${edition}, пп. 15.1–15.5. Сверьте приоритет поезда, сигналы переездного светофора, шлагбаум и указания дежурного. Пропуск не должен создавать затор с остановкой на путях; определите места ожидания и порядок действий при вынужденной остановке. Проверьте запреты въезда, объезда очереди и открытия шлагбаума. Размеры отгона и буфера на условном листе не подтверждают места остановки по п. 15.4.`,
      path: 'placements',
      basis: basis([scheme.crossing, parameters.workZones, parameters.regulation, placements]),
    },
  ]
  if (placements.some((item) => item.kind === 'sign-post'))
    checks.push({
      id: 'pdd-temporary',
      kind: 'verify',
      title: 'Временные знаки, разметка и зоны действия',
      detail: `${edition}, приложение 1 (разделы 3 и 8), приложение 2, раздел 1; п. 1.2. Проверьте противоречия с постоянными знаками и разметкой: временные знаки имеют приоритет над постоянными, знаки — над горизонтальной разметкой, временная разметка — над постоянной. Жёлтый фон предусмотрен для перечисленных в приложении 1 знаков, а не для всех. Сверьте конец ограничений 3.20/3.24, ближайший перекрёсток и конец населённого пункта, таблички и знаки отмены. Выезд с прилегающей территории не является перекрёстком; действие также не прерывается у примыканий полевых, лесных и других второстепенных дорог без соответствующих знаков.`,
      path: 'placements',
      basis: basis([parameters.yellowTemporarySigns, parameters.location, placements]),
    })
  if (
    parameters.regulation.mode === 'one' ||
    parameters.regulation.mode === 'two' ||
    placements.some((item) => item.kind === 'element' && item.elementKind === 'reg')
  )
    checks.push({
      id: 'pdd-regulator',
      kind: 'verify',
      title: 'Указания регулировщика по ПДД',
      detail: `${edition}, п. 6.15 и раздел 15. Сверьте организацию сигналов и распоряжений регулировщика, их приоритет перед светофорами, знаками и разметкой и согласование с работой переезда. Проверьте статус, подготовку и полномочия персонала по определению «Регулировщик» в п. 1.2. Само изображение человека на листе не подтверждает организацию безопасного пропуска.`,
      path: 'parameters.regulation',
      basis: basis([parameters.regulation, parameters.workConditions, placements]),
    })
  return checks.map((check) => ({
    ...check,
    ...(!rules.pddDocument
      ? {
          markBlocked:
            'Добавьте ПДД (постановление от 23.10.1993 № 1090) в библиотеку, укажите редакцию и дату введения. Затем сверяйте условия по этому документу.',
        }
      : {}),
  }))
}
