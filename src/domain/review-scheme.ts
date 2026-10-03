import type { Scheme } from './model'
import { figureDimensions } from './figure-dimensions'
import { PROTOTYPE_RULES, type NormativeRules } from './normative-parameters'
import { templateLabel } from './registry'
import { anchorCoordinates, placementCoordinates } from './placement-workspace'
import { dangerousSectionMetres, usesTwoRegulators } from './template-placements'
import { ZONE_PLATE } from './sign-code'
import { parseHourly } from './regulation-advice'
import { workSectionMetres, workTrafficDecision } from './work-traffic'
import {
  distanceTitles,
  expectedTypesize,
  typesizeSource,
  largestSpeedStep,
  normativeDeviations,
  warningDistanceProblem,
} from './normative-defaults'

export type ReviewFinding = {
  id: string
  kind: 'fill' | 'verify'
  title: string
  detail: string
  /** Semantic path in the project data; presentation decides where to navigate. */
  path: string
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
      path: place[0]![2],
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
        path: missing[0]![2],
      })
    }
  }

  // Без местоположения не подставляются и не сверяются расстояния и скорости (старые проекты).
  if (parameters.location === 'auto') {
    findings.push({
      id: 'location',
      kind: 'fill',
      title: 'Местоположение',
      detail:
        'Не указано, находится ли место работ в населённом пункте. От этого зависят расстояния до знаков, ступени скорости и их проверка; без выбора шаблон не собирается, а лист не выпускается.',
      path: 'parameters.location',
    })
  }

  if (!placements.length) {
    findings.push({
      id: 'placements',
      kind: 'fill',
      title: 'Объекты схемы',
      detail: 'На координатной области нет объектов. Добавьте их после сверки с условиями работ.',
      path: 'placements',
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
        title: `Расстояние «${distanceTitles[name]}»`,
        detail: `Маркер {${name}} указан на стойках № ${postIds.join(', ')}, а расстояние не введено.`,
        path: `parameters.signDistancesMetres.${name}`,
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
    path: 'crossing',
    basis: JSON.stringify(crossing),
  })

  findings.push({
    id: 'template',
    kind: 'verify',
    title: 'Вариант и расстановка',
    detail: `Вариант ${templateLabel(scheme.template.code)} и размещение объектов не прошли предметную проверку. Сверьте геометрию, условия работ, существующие знаки и применимую редакцию ОДМ.`,
    path: 'placements',
    // Всё, от чего зависит раскладка шаблона: параметры схемы (кроме названия участка и
    // направлений — это подписи листа) и значения нормативных параметров.
    basis: JSON.stringify([
      scheme.template,
      { ...parameters, locationText: undefined, directions: undefined },
      { ...rules, sources: undefined, confirmed: undefined },
      placements,
    ]),
  })

  // Типоразмер — отдельным пунктом ниже: ошибка в нём меняет все знаки листа.
  const deviations = normativeDeviations(parameters, rules).filter(
    (item) => item.field !== 'parameters.signSize',
  )
  if (deviations.length) {
    findings.push({
      id: 'normative-values',
      kind: 'verify',
      title: 'Расстояния и скорости не по нормативным значениям',
      detail: `Отличаются от значений по умолчанию: ${deviations
        .map(
          (item) =>
            `${item.title} — ${item.value === null ? 'не указано' : item.value} (по нормативу ${item.normative}, ${item.source})`,
        )
        .join('; ')}. Исправление под местные условия допустимо — проверьте его обоснование.`,
      path: deviations[0]!.field,
      basis: JSON.stringify(
        deviations.map(({ field, value, normative }) => [field, value, normative]),
      ),
    })
  }

  const typesize =
    parameters.location === 'auto' ? null : expectedTypesize(parameters.location, rules)
  if (parameters.signSize === 'auto') {
    findings.push({
      id: 'typesize',
      kind: 'fill',
      title: 'Типоразмер знаков',
      detail: typesize
        ? `Типоразмер не выбран. По таблице 1 ГОСТ Р 52289 для дороги с двумя и тремя полосами вне населённого пункта — ${typesize} (${typesizeSource(rules)}).`
        : 'Типоразмер не выбран. В населённом пункте он зависит от класса улицы (ГОСТ Р 52289, п. 5.1.16, табл. 1).',
      path: 'parameters.signSize',
    })
  } else if (typesize && parameters.signSize !== typesize) {
    findings.push({
      id: 'typesize',
      kind: 'verify',
      title: 'Типоразмер знаков не по таблице 1',
      detail: `Выбран типоразмер ${parameters.signSize}, а по таблице 1 для дороги с двумя и тремя полосами вне населённого пункта — ${typesize} (${typesizeSource(rules)}). Схемы Б.33/Б.34 рассчитаны на дорогу с двумя полосами; категория дороги из ПУ-66 описывает дорогу в целом, поэтому число полос у места работ проверьте на месте. Больший типоразмер допускается при необходимости (п. 5.1.16), IV — для работ на дорогах IА и IБ категории; на одной дороге предпочтительно один типоразмер. Проверьте основание или верните ${typesize} на этапе 2.`,
      path: 'parameters.signSize',
      basis: JSON.stringify([parameters.signSize, typesize]),
    })
  }

  const zonePlates = zonePlateProblems(scheme)
  if (zonePlates) {
    findings.push({
      id: 'zone-plate',
      kind: 'verify',
      title: 'Табличка 8.2.1 у знака 1.25',
      detail: zonePlates,
      path: 'placements',
      markBlocked:
        'Табличка показывает неверную протяжённость: пересоберите шаблон на этапе 3 или исправьте код таблички у стойки.',
    })
  }

  const warning = warningDistanceProblem(parameters, rules)
  if (warning) {
    findings.push({
      id: 'warning-distance',
      kind: 'verify',
      title: 'Расстояние до знака 1.25 вне диапазона',
      detail: `Знак 1.25 стоит в ${warning.value} м до начала работ, а диапазон — от ${warning.range[0]} до ${warning.range[1]} м (${warning.source}). Иное расстояние допускается, но указывается на табличке 8.1.1 — проверьте её на стойках со знаком 1.25.`,
      path: `parameters.signDistancesMetres.${parameters.location === 'in' ? 'n100' : 'd300'}`,
      basis: JSON.stringify([warning.value, warning.range]),
    })
  }

  const step = largestSpeedStep(parameters)
  if (step !== null && step > rules.speedStepKmh) {
    findings.push({
      id: 'speed-step',
      kind: 'verify',
      title: 'Шаг ступеней скорости',
      detail: `Между соседними ступенями (от разрешённой скорости ${parameters.approachSpeedKmh} км/ч до скорости в зоне) перепад ${step} км/ч — больше ${rules.speedStepKmh} км/ч (${rules.sources['gost-speed-step']}). Проверьте ступени на этапе 2.`,
      path: 'parameters.approachSpeedKmh',
      basis: JSON.stringify([parameters.approachSpeedKmh, parameters.speedStagesKmh]),
    })
  }

  const differingDimensions = figureDimensions(scheme, rules).filter(
    (part) => !part.agreesWithFigure,
  )
  if (differingDimensions.length) {
    findings.push({
      id: 'figure-dimensions',
      kind: 'verify',
      title: `Размерная цепочка рисунка ${templateLabel(scheme.template.code)}`,
      detail: `Введённые размеры отличаются от ожидаемых: ${differingDimensions.map((part) => `${part.title.toLowerCase()} ${part.enteredMetres} м (${part.basis ?? `на рисунке ${part.figureLabel}`})`).join('; ')}. Сверьте размеры и условия конкретных работ.`,
      path: 'parameters',
    })
  }

  const frontMetres = parameters.workZones[scheme.template.code]?.workMetres
  if (frontMetres !== undefined && (frontMetres < 30 ? 'b34' : 'b33') !== scheme.template.code) {
    findings.push({
      id: 'variant-front',
      kind: 'verify',
      title: 'Вариант и длина фронта',
      detail: `В импортированном проекте выбран ${templateLabel(scheme.template.code)} при фронте ${frontMetres} м. По подтверждённому правилу проекта нужен ${frontMetres < 30 ? 'Б.34' : 'Б.33'}. Проверьте исходный лист перед правкой.`,
      path: 'parameters',
    })
  }

  if (scheme.template.code === 'b34') {
    const section = workSectionMetres(parameters.workZones.b34)
    const decision = workTrafficDecision(
      section,
      parseHourly(parameters.regulation.hourly),
      parameters.regulation.vis,
      rules,
    )
    const incompatible =
      decision === 'outside' ||
      decision === 'signals' ||
      decision === 'unknown' ||
      parameters.regulation.mode === 'auto' ||
      (parameters.regulation.mode === 'signs' &&
        (decision !== 'signs' ||
          parameters.workZones.b34?.taperMetres !== rules.signsTaperMetres)) ||
      (parameters.regulation.mode === 'one' &&
        (!parameters.regulation.straight || parameters.regulation.vis))
    const regulators = placements.filter(
      (placement) => placement.kind === 'element' && placement.elementKind === 'reg',
    ).length
    findings.push({
      id: 'b34-traffic',
      kind: 'verify',
      title: 'Условия движения для Б.34',
      detail: `На листе размещено регулировщиков: ${regulators}; расчётный участок проведения работ ${section ?? 'не введён'} м (отгон + буфер + фронт). Сверьте фактические границы устройств, интенсивность в двух направлениях и видимость встречного автомобиля (${rules.sources['odm-signs-hourly']}; ${rules.sources['gost-work-traffic']}). Для одного регулировщика отдельно проверьте видимость с обоих концов, небольшой фронт, прямой участок, светлое время суток и ограничения скорости (ОДМ, п. 13.7.5). Замена светофора требует постоянного присутствия регулировщиков (п. 6.4.3).`,
      ...(incompatible
        ? {
            markBlocked: `Выбранный режим, отгон или условия видимости не соответствуют проверяемым условиям ОДМ и ГОСТ Р 58350 (${rules.sources['gost-work-traffic']}); исправьте условия или выберите отдельную схему со светофором/иным пропуском.`,
          }
        : {}),
      path: 'placements',
      basis: JSON.stringify([
        parameters.regulation,
        parameters.location,
        regulators,
        section,
        decision,
        rules.workTraffic,
        rules.signsLengthMetres,
        rules.signsHourly,
        rules.alternateHourly,
        rules.signsTaperMetres,
        rules.sources['gost-work-traffic'],
        rules.sources['odm-signs-length'],
        rules.sources['odm-signs-hourly'],
        rules.sources['odm-alternate-hourly'],
        rules.sources['odm-signs-taper'],
      ]),
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
      detail: `В исходном файле HTML-прототипа видимость встречного автомобиля отмечена как ${legacyVisibility ? 'обеспеченная' : 'необеспеченная'}, а в проекте флаг «Видимость встречного автомобиля ограничена» ${parameters.regulation.vis ? 'установлен' : 'снят'}. Проекты, импортированные до исправления, получили обратное значение. Проверьте флаг на этапе 2 до выбора регулирования.`,
      path: 'parameters',
    })
  }

  if (parameters.workZones[scheme.template.code]?.workMetres === 30) {
    findings.push({
      id: 'boundary-30',
      kind: 'verify',
      title: 'Фронт работ ровно 30 м',
      detail:
        'Б.33 выбран по подтверждённому правилу проекта. Подпись и размерное обозначение ОДМ различаются; проверьте применимость остальных условий схемы.',
      path: 'parameters',
    })
  }

  if (placements.some((placement) => placement.kind === 'sign-post')) {
    findings.push({
      id: 'signs',
      kind: 'verify',
      title: 'Знаки на стойках',
      detail:
        'Сверьте коды, изображения PNG и применимость знаков в локальном каталоге. Совпадение кода с каталогом не подтверждает применимость.',
      path: 'signImages',
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
 * ОДМ до рабочей зоны Z0–Z1 со стороны своего направления (п. 13.7.3). Пункт появляется, только
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
    path: 'placements' as const,
  }
  if (required === undefined)
    return {
      ...base,
      detail: `Скорости в зоне ${zoneSpeed} км/ч нет в таблице расстояний (${source}). Определите расстояние от регулировщиков до рабочей зоны и проверьте их положение на листе.`,
      basis: JSON.stringify([zoneSpeed, scheme.placements]),
    }
  const anchors = anchorCoordinates(scheme)
  const unitsPerMetre = (anchors.Z1 - anchors.Z0) / zone.workMetres
  const regulators = scheme.placements.filter(
    (placement) => placement.kind === 'element' && placement.elementKind === 'reg',
  )
  const problems: string[] = []
  if (regulators.length !== 2) problems.push(`на листе регулировщиков: ${regulators.length} из 2`)
  let leftCount = 0
  let rightCount = 0
  for (const regulator of regulators) {
    const { x } = placementCoordinates(regulator, anchors)
    if (x >= anchors.Z0 && x <= anchors.Z1) {
      problems.push(`№ ${regulator.id} стоит над рабочей зоной`)
      continue
    }
    if (x < anchors.Z0) leftCount++
    else rightCount++
    const metres = (x < anchors.Z0 ? anchors.Z0 - x : x - anchors.Z1) / unitsPerMetre
    if (metres < required - 0.5)
      problems.push(
        metres <= 0
          ? `№ ${regulator.id} стоит над рабочей зоной`
          : `№ ${regulator.id} — примерно ${Math.round(metres)} м до рабочей зоны`,
      )
  }
  if (leftCount !== 1) problems.push(`со стороны начала работ (Z0): ${leftCount} вместо 1`)
  if (rightCount !== 1) problems.push(`со стороны конца работ (Z1): ${rightCount} вместо 1`)
  if (!problems.length) return null
  return {
    ...base,
    detail: `Регулировщики должны стоять не ближе ${required} м до рабочей зоны при скорости ${zoneSpeed} км/ч (${source}): ${problems.join('; ')}. Пересоберите шаблон на этапе 3 или передвиньте объекты; если так задумано, зафиксируйте решение.`,
    basis: JSON.stringify([required, regulators]),
  }
}

/**
 * Табличка 8.2.1 при повторном знаке 1.25 указывает протяжённость опасного участка — от начала
 * отвода до конца работ (ГОСТ Р 52289-2019, п. 5.9.5). Изображение «8.2.1» из каталога несёт
 * пример «100 м» из ГОСТ Р 52290; «8.2.1_N» с другим числом, чем текущая протяжённость, остаётся
 * после изменения размеров зоны без пересборки шаблона.
 */
function zonePlateProblems(scheme: Scheme): string | null {
  const expected = dangerousSectionMetres(scheme)
  if (expected === null) return null
  const shown = (value: number | string) => `${String(value).replace('.', ',')} м`
  const problems: string[] = []
  for (const placement of scheme.placements) {
    if (placement.kind !== 'sign-post' || !placement.signIds.includes('1.25')) continue
    for (const code of placement.signIds) {
      if (code === '8.2.1') problems.push(`№ ${placement.id} — изображение ГОСТ с примером «100 м»`)
      const value = ZONE_PLATE.exec(code)?.[1]
      if (value !== undefined && Number(value) !== expected)
        problems.push(`№ ${placement.id} — ${shown(value)}`)
    }
  }
  if (!problems.length) return null
  return `Протяжённость опасного участка от начала отвода до конца работ — ${shown(expected)} (ГОСТ Р 52289-2019, п. 5.9.5), а на табличках стоек: ${problems.join('; ')}. Пересоберите шаблон на этапе 3 или укажите у стойки код 8.2.1_${expected}.`
}
