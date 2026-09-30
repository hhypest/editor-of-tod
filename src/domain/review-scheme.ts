import type { Scheme } from './model'
import { figureDimensions } from './figure-dimensions'
import { PROTOTYPE_RULES, type NormativeRules } from './normative-parameters'
import { templateLabel } from './registry'
import { anchorCoordinates, placementCoordinates } from './placement-workspace'
import { usesTwoRegulators } from './template-placements'

export type ReviewFinding = {
  id: string
  kind: 'fill' | 'verify'
  title: string
  detail: string
  target: '#details-title' | '#placements-title' | '#pu66-link-title' | '#imported-title'
  /** Путь первого незаполненного поля формы (`data-field`), к которому переходит «Перейти». */
  field?: string
  /**
   * Данные, которые проверяет составитель в пункте «Проверить вручную». Не показываются, но
   * входят в отпечаток отметки: после их изменения отметка «Проверено» перестаёт действовать.
   */
  basis?: string
  /** Почему пункт пока нельзя отметить «Проверено» (например, PNG знаков не закреплены). */
  markBlocked?: string
}

const distanceNames = ['d300', 'd250', 'd150', 'd50', 'n100', 'n50'] as const

function isBlank(value: string): boolean {
  return value.trim().length === 0
}

type Field = readonly [label: string, value: string, path: string]

function missingFields(fields: ReadonlyArray<Field>): Field[] {
  return fields.filter(([, value]) => isBlank(value))
}

function labels(fields: ReadonlyArray<Field>): string {
  return fields.map(([label]) => label).join(', ')
}

let visibilityCache: { json: string; value: boolean | null } | null = null

/** `params.reg.vis` исходного v1 JSON («видимость обеспечена») или null, если его нет. */
function legacyVisibilityEnsured(scheme: Scheme): boolean | null {
  if (scheme.source.kind !== 'legacy-html-v1') return null
  const json = scheme.source.originalJson
  if (visibilityCache?.json !== json) {
    const match = /"reg"\s*:\s*\{[^{}]*?"vis"\s*:\s*(true|false)/.exec(json)
    visibilityCache = { json, value: match ? match[1] === 'true' : null }
  }
  return visibilityCache.value
}

/** A live checklist of data entry and manual review, never a normative compliance decision. */
export function reviewScheme(
  scheme: Scheme,
  rules: NormativeRules = PROTOTYPE_RULES,
): ReviewFinding[] {
  const findings: ReviewFinding[] = []
  const { parameters, titleBlock, crossing, placements } = scheme

  const place = missingFields([
    ['участок', parameters.locationText, 'parameters.locationText'],
    ['направление слева', parameters.directions.left, 'parameters.directions.left'],
    ['направление справа', parameters.directions.right, 'parameters.directions.right'],
  ])
  if (place.length) {
    findings.push({
      id: 'place',
      kind: 'fill',
      title: 'Место работ и направления',
      detail: `Не заполнено: ${labels(place)}.`,
      target: '#details-title',
      field: place[0]![2],
    })
  }

  const titleGroups: ReadonlyArray<{
    id: string
    title: string
    fields: ReadonlyArray<Field>
  }> = [
    {
      id: 'developer',
      title: 'Разработчик',
      fields: [
        ['организация', titleBlock.developer.organization, 'titleBlock.developer.organization'],
        ['должность', titleBlock.developer.position, 'titleBlock.developer.position'],
        ['ФИО', titleBlock.developer.name, 'titleBlock.developer.name'],
        ['дата', titleBlock.developer.date, 'titleBlock.developer.date'],
      ],
    },
    {
      id: 'work',
      title: 'Сведения о работах',
      fields: [
        ['организация', titleBlock.work.organization, 'titleBlock.work.organization'],
        ['описание', titleBlock.work.description, 'titleBlock.work.description'],
        ['период', titleBlock.work.period, 'titleBlock.work.period'],
      ],
    },
    {
      id: 'responsible',
      title: 'Ответственные',
      // Первый ответственный обязателен, второй проверяется, только если добавлен.
      fields: titleBlock.responsible.flatMap((person, index): Field[] => {
        const who = index === 0 ? 'первого' : 'второго'
        return [
          [`должность ${who}`, person.position, `titleBlock.responsible.${index}.position`],
          [`ФИО ${who}`, person.name, `titleBlock.responsible.${index}.name`],
          [`телефон ${who}`, person.phone, `titleBlock.responsible.${index}.phone`],
        ]
      }),
    },
    {
      id: 'approver',
      title: 'Утверждение владельцем дороги',
      fields: [
        ['должность', titleBlock.approver.position, 'titleBlock.approver.position'],
        ['организация', titleBlock.approver.organization, 'titleBlock.approver.organization'],
        ['ФИО', titleBlock.approver.name, 'titleBlock.approver.name'],
      ],
    },
    {
      id: 'agreement',
      title: 'Согласование с Госавтоинспекцией',
      fields: [
        ['должность', titleBlock.agreement.position, 'titleBlock.agreement.position'],
        ['ФИО', titleBlock.agreement.name, 'titleBlock.agreement.name'],
        ['год', titleBlock.agreement.year, 'titleBlock.agreement.year'],
      ],
    },
  ]
  for (const group of titleGroups) {
    const missing = missingFields(group.fields)
    if (missing.length) {
      findings.push({
        id: group.id,
        kind: 'fill',
        title: group.title,
        detail: `Не заполнено: ${labels(missing)}. Состав реквизитов проверьте для конкретного листа.`,
        target: '#details-title',
        field: missing[0]![2],
      })
    }
  }

  if (!placements.length) {
    findings.push({
      id: 'placements',
      kind: 'fill',
      title: 'Объекты схемы',
      detail: 'На координатной области нет объектов. Добавьте их после сверки с условиями работ.',
      target: '#placements-title',
    })
  }

  for (const name of distanceNames) {
    const postIds = placements
      .filter(
        (placement) =>
          placement.kind === 'sign-post' && placement.distanceLabel?.includes(`{${name}}`),
      )
      .map((placement) => placement.id)
    if (postIds.length && parameters.signDistancesMetres[name] === null) {
      findings.push({
        id: `distance-${name}`,
        kind: 'fill',
        title: `Расстояние ${name}`,
        detail: `Маркер {${name}} указан на стойках № ${postIds.join(', ')}, а расстояние не введено.`,
        target: '#details-title',
        field: `parameters.signDistancesMetres.${name}`,
      })
    }
  }

  findings.push({
    id: 'crossing',
    kind: 'verify',
    title: 'Данные переезда',
    detail:
      crossing.source === 'local-pu66'
        ? `Закреплена локальная редакция ПУ-66 № ${crossing.snapshot.revision}. Сверьте её актуальность с линейным подразделением и состав сведений для листа.`
        : crossing.source === 'legacy-pu66'
          ? 'Идентификатор перенесён из старого проекта; локальная карточка ПУ-66 не закреплена. Сверьте данные перед использованием.'
          : 'Идентификатор введён вручную; локальная карточка ПУ-66 не закреплена. Сверьте данные перед использованием.',
    target: '#pu66-link-title',
    basis: JSON.stringify(crossing),
  })

  findings.push({
    id: 'template',
    kind: 'verify',
    title: 'Вариант и расстановка',
    detail: `Вариант ${templateLabel(scheme.template.code)} и размещение объектов не прошли предметную проверку. Сверьте геометрию, условия работ, существующие знаки и применимую редакцию ОДМ.`,
    target: '#placements-title',
    // Всё, от чего зависит раскладка шаблона: параметры схемы (кроме названия участка и
    // направлений — это подписи листа) и значения нормативных параметров.
    basis: JSON.stringify([
      scheme.template,
      { ...parameters, locationText: undefined, directions: undefined },
      { ...rules, sources: undefined, confirmed: undefined },
      placements,
    ]),
  })

  const differingDimensions = figureDimensions(scheme, rules).filter(
    (part) => !part.agreesWithFigure,
  )
  if (differingDimensions.length) {
    findings.push({
      id: 'figure-dimensions',
      kind: 'verify',
      title: `Размерная цепочка рисунка ${templateLabel(scheme.template.code)}`,
      detail: `Введённые размеры отличаются от ожидаемых: ${differingDimensions.map((part) => `${part.title.toLowerCase()} ${part.enteredMetres} м (${part.basis ?? `на рисунке ${part.figureLabel}`})`).join('; ')}. Сверьте размеры и условия конкретных работ.`,
      target: '#details-title',
    })
  }

  const frontMetres = parameters.workZones[scheme.template.code]?.workMetres
  if (frontMetres !== undefined && (frontMetres < 30 ? 'b34' : 'b33') !== scheme.template.code) {
    findings.push({
      id: 'variant-front',
      kind: 'verify',
      title: 'Вариант и длина фронта',
      detail: `В импортированном проекте выбран ${templateLabel(scheme.template.code)} при фронте ${frontMetres} м. По подтверждённому правилу проекта нужен ${frontMetres < 30 ? 'Б.34' : 'Б.33'}. Проверьте исходный лист перед правкой.`,
      target: '#details-title',
    })
  }

  if (scheme.template.code === 'b34') {
    const regulators = placements.filter(
      (placement) => placement.kind === 'element' && placement.elementKind === 'reg',
    ).length
    findings.push({
      id: 'b34-traffic',
      kind: 'verify',
      title: 'Условия движения для Б.34',
      detail: `На листе размещено регулировщиков: ${regulators}. Подпись к рисунку Б.34 указывает на регулировщика при интенсивности более ${rules.signsHourly} авт./ч в двух направлениях или ограниченной видимости (${rules.sources['odm-signs-hourly']}). Оцените условия на месте и зафиксируйте решение составителя.`,
      target: '#placements-title',
      basis: JSON.stringify([parameters.regulation, parameters.location, regulators]),
    })
  }

  const regulatorFinding = regulatorDistanceFinding(scheme, rules)
  if (regulatorFinding) findings.push(regulatorFinding)

  const legacyVisibility = legacyVisibilityEnsured(scheme)
  if (legacyVisibility !== null && parameters.regulation.vis === legacyVisibility) {
    findings.push({
      id: 'legacy-visibility',
      kind: 'verify',
      title: 'Видимость на участке',
      detail: `В исходном файле HTML-прототипа видимость встречного автомобиля отмечена как ${legacyVisibility ? 'обеспеченная' : 'необеспеченная'}, а в проекте флаг «Видимость ограничена» ${parameters.regulation.vis ? 'установлен' : 'снят'}. Проекты, импортированные до исправления, получили обратное значение. Проверьте флаг на этапе 2 до выбора регулирования.`,
      target: '#details-title',
    })
  }

  if (parameters.workZones[scheme.template.code]?.workMetres === 30) {
    findings.push({
      id: 'boundary-30',
      kind: 'verify',
      title: 'Фронт работ ровно 30 м',
      detail:
        'Б.33 выбран по подтверждённому правилу проекта. Подпись и размерное обозначение ОДМ различаются; проверьте применимость остальных условий схемы.',
      target: '#details-title',
    })
  }

  if (placements.some((placement) => placement.kind === 'sign-post')) {
    findings.push({
      id: 'signs',
      kind: 'verify',
      title: 'Знаки на стойках',
      detail:
        'Сверьте коды, изображения PNG и применимость знаков в локальном каталоге. Совпадение кода с каталогом не подтверждает применимость.',
      target: '#imported-title',
      basis: JSON.stringify([
        placements.flatMap((placement) =>
          placement.kind === 'sign-post' ? [placement.signIds] : [],
        ),
        parameters.yellowTemporarySigns,
        parameters.signSize,
        scheme.signImages,
      ]),
      // Без закрепления лист показывает текущий каталог: после его обновления изображения
      // сменились бы, а отметка осталась бы действующей.
      ...(scheme.signImages.catalog
        ? {}
        : {
            markBlocked:
              'Сначала закрепите редакции PNG на этапе 3 («Закрепить редакции PNG»): без закрепления изображения знаков меняются вместе с каталогом.',
          }),
    })
  }

  return findings
}

/**
 * Два регулировщика стоят у начала и конца места работ, каждый не ближе расстояния по табл. 5
 * ОДМ до рабочей зоны Z0–Z1 со стороны своего направления (п. 12.7.2). Пункт появляется, только
 * если на листе это не так или расстояние не определено: примечание листа — требование, а этот
 * пункт сверяет с ним фактические объекты.
 */
function regulatorDistanceFinding(scheme: Scheme, rules: NormativeRules): ReviewFinding | null {
  if (!usesTwoRegulators(scheme)) return null
  const zone = scheme.parameters.workZones[scheme.template.code]
  if (!zone) return null
  const source = rules.sources['odm-regulator-distance']
  const zoneSpeed = scheme.parameters.speedStagesKmh[2]
  const required = rules.regulatorDistance[zoneSpeed]
  const base = {
    id: 'regulator-distance',
    kind: 'verify' as const,
    title: 'Расстояние от регулировщиков',
    target: '#placements-title' as const,
  }
  if (required === undefined)
    return {
      ...base,
      detail: `Скорости в зоне ${zoneSpeed} км/ч нет в таблице расстояний (${source}). Определите расстояние от регулировщиков до рабочей зоны и проверьте их положение на листе.`,
      basis: JSON.stringify([zoneSpeed, scheme.placements]),
    }
  const anchors = anchorCoordinates(scheme)
  const unitsPerMetre = (anchors.Z1 - anchors.Z0) / zone.workMetres
  const middle = (anchors.Z0 + anchors.Z1) / 2
  const regulators = scheme.placements.filter(
    (placement) => placement.kind === 'element' && placement.elementKind === 'reg',
  )
  const problems: string[] = []
  if (regulators.length < 2) problems.push(`на листе регулировщиков: ${regulators.length} из 2`)
  for (const regulator of regulators) {
    const { x } = placementCoordinates(regulator, anchors)
    const metres = (x <= middle ? anchors.Z0 - x : x - anchors.Z1) / unitsPerMetre
    if (metres < required - 0.5)
      problems.push(
        metres <= 0
          ? `№ ${regulator.id} стоит над рабочей зоной`
          : `№ ${regulator.id} — примерно ${Math.round(metres)} м до рабочей зоны`,
      )
  }
  if (!problems.length) return null
  return {
    ...base,
    detail: `Регулировщики должны стоять не ближе ${required} м до рабочей зоны при скорости ${zoneSpeed} км/ч (${source}): ${problems.join('; ')}. Пересоберите шаблон на этапе 3 или передвиньте объекты; если так задумано, зафиксируйте решение.`,
    basis: JSON.stringify([required, regulators]),
  }
}
