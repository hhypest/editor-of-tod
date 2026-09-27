import type { Scheme } from './model'

export type ReviewFinding = {
  id: string
  kind: 'fill' | 'verify'
  title: string
  detail: string
  target: '#details-title' | '#placements-title' | '#pu66-link-title' | '#imported-title'
}

const distanceNames = ['d300', 'd250', 'd150', 'd50'] as const

function isBlank(value: string): boolean {
  return value.trim().length === 0
}

function missingFields(fields: ReadonlyArray<readonly [string, string]>): string[] {
  return fields.filter(([, value]) => isBlank(value)).map(([label]) => label)
}

/** A live checklist of data entry and manual review, never a normative compliance decision. */
export function reviewScheme(scheme: Scheme): ReviewFinding[] {
  const findings: ReviewFinding[] = []
  const { parameters, titleBlock, crossing, placements } = scheme

  const place = missingFields([
    ['участок', parameters.locationText],
    ['направление слева', parameters.directions.left],
    ['направление справа', parameters.directions.right],
  ])
  if (place.length) {
    findings.push({
      id: 'place',
      kind: 'fill',
      title: 'Место работ и направления',
      detail: `Не заполнено: ${place.join(', ')}.`,
      target: '#details-title',
    })
  }

  const titleGroups: ReadonlyArray<{
    id: string
    title: string
    fields: ReadonlyArray<readonly [string, string]>
  }> = [
    {
      id: 'developer',
      title: 'Разработчик',
      fields: [
        ['организация', titleBlock.developer.organization],
        ['ФИО', titleBlock.developer.name],
        ['дата', titleBlock.developer.date],
      ],
    },
    {
      id: 'work',
      title: 'Сведения о работах',
      fields: [
        ['организация', titleBlock.work.organization],
        ['описание', titleBlock.work.description],
        ['период', titleBlock.work.period],
      ],
    },
    {
      id: 'responsible',
      title: 'Ответственные',
      fields: [
        ['первый', titleBlock.responsible[0]],
        ['второй', titleBlock.responsible[1]],
      ],
    },
    {
      id: 'approver',
      title: 'Утверждение владельцем дороги',
      fields: [
        ['должность', titleBlock.approver.position],
        ['организация', titleBlock.approver.organization],
        ['ФИО', titleBlock.approver.name],
      ],
    },
    {
      id: 'agreement',
      title: 'Согласование с Госавтоинспекцией',
      fields: [
        ['должность', titleBlock.agreement.position],
        ['ФИО', titleBlock.agreement.name],
        ['год', titleBlock.agreement.year],
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
        detail: `Не заполнено: ${missing.join(', ')}. Состав реквизитов проверьте для конкретного листа.`,
        target: '#details-title',
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
  })

  findings.push({
    id: 'template',
    kind: 'verify',
    title: 'Вариант и расстановка',
    detail: `Вариант ${scheme.template.code.toUpperCase()} и размещение объектов не прошли предметную проверку. Сверьте геометрию, условия работ, существующие знаки и применимую редакцию ОДМ.`,
    target: '#placements-title',
  })

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
    })
  }

  return findings
}
