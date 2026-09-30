import { schemeSchema, type Scheme } from './model'
import { PROTOTYPE_RULES, type NormativeRules } from './normative-parameters'
import { parseHourly } from './regulation-advice'
import { anchorCoordinates } from './placement-workspace'
import { distanceTitles, type DistanceField } from './normative-defaults'

type Placement = Scheme['placements'][number]

/** Sources for a preliminary drawing profile, not a statement that a project complies. */
export const draftTemplateProfile = {
  id: 'draft-2',
  source: 'ОДМ 218.6.019-2016',
  clauses: {
    figures: 'Приложение Б, рисунки Б.33 и Б.34 (стр. 100–101)',
    roadworks: '8.1.2.2',
    priority: '4.1.8.3, 5.4.4, 8.1.3.1',
    regulators: '12.7.2–12.7.3, таблица 5',
    settlement: 'ГОСТ Р 52289-2019, пп. 5.2.2, 5.4.22 — расстояния и ступени скорости сверяются',
  },
  /**
   * Смещения стоек от начала отвода (L0) и конца зоны (E) в единицах листа 1680 × 1188.
   * Это компоновка рисунка, а не расстояния на местности: расстояния подписываются маркерами.
   */
  offsets: {
    outside: {
      regular: { before: [-520, -410, -290, -170], after: [170, 290, 410, 500] },
      priority: { before: [-600, -520, -412, -210], after: [208, 332, 452, 536] },
    },
    settlement: {
      regular: { far: -410, near: -255, afterNear: 255, afterFar: 420 },
      priority: { far: -540, near: -385, afterNear: 300, afterFar: 465 },
    },
  },
} as const

export class TemplateBuildError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TemplateBuildError'
  }
}

/** Два регулировщика: Б.33 всегда, Б.34 — при выбранном регулировании двумя регулировщиками. */
export function usesTwoRegulators(scheme: Scheme): boolean {
  return (
    scheme.template.code === 'b33' ||
    (scheme.template.code === 'b34' && scheme.parameters.regulation.mode === 'two')
  )
}

function checkConditions(scheme: Scheme, rules: NormativeRules): void {
  const { parameters, template } = scheme
  if (parameters.location === 'auto') {
    throw new TemplateBuildError('На этапе 2 укажите, находится ли переезд в населённом пункте.')
  }
  if (parameters.location === 'in' && parameters.approachSpeedKmh === null) {
    throw new TemplateBuildError(
      'На этапе 2 укажите разрешённую скорость на подходе: от неё считаются ступени скорости в населённом пункте.',
    )
  }
  // Два регулировщика (Б.33 всегда, Б.34 по решению) ставятся по табл. 5 ОДМ: скорость в зоне
  // должна быть в таблице, иначе минимальное расстояние не определено.
  if (usesTwoRegulators(scheme)) {
    const zoneSpeed = parameters.speedStagesKmh[2]
    if (rules.regulatorDistance[zoneSpeed] === undefined) {
      const speeds = Object.keys(rules.regulatorDistance).join(', ')
      throw new TemplateBuildError(
        `Скорости в зоне ${zoneSpeed} км/ч нет в таблице расстояний от регулировщика до рабочей зоны (${rules.sources['odm-regulator-distance']}). Укажите третью ступень скорости из таблицы: ${speeds} км/ч.`,
      )
    }
  }
  if (template.code !== 'b34') return
  const { regulation } = parameters
  if (regulation.mode === 'auto') {
    throw new TemplateBuildError(
      'На этапе 2 выберите способ регулирования Б.34 после оценки условий.',
    )
  }
  if (regulation.mode === 'signs') {
    const hourly = parseHourly(regulation.hourly)
    if (hourly === null || hourly >= rules.signsHourly || regulation.vis) {
      throw new TemplateBuildError(
        `Для варианта со знаками 2.6/2.7 укажите интенсивность менее ${rules.signsHourly} авт./ч и подтвердите достаточную видимость (${rules.sources['odm-signs-hourly']}).`,
      )
    }
    if (parameters.workZones.b34?.taperMetres !== rules.signsTaperMetres) {
      throw new TemplateBuildError(
        `Для знаков 2.6/2.7 проверьте и укажите отгон ${rules.signsTaperMetres} м (${rules.sources['odm-signs-taper']}).`,
      )
    }
  }
  if (regulation.mode === 'one' && (!regulation.straight || regulation.vis)) {
    throw new TemplateBuildError(
      'Один регулировщик возможен после подтверждения прямого участка и видимости с двух сторон (ОДМ, п. 12.7.3).',
    )
  }
}

/**
 * Табличка 8.1.1 у знака 2.6 перед сужением: расстояние берётся только из введённого значения,
 * без подстановки и округления. В архиве табличка «300 м» хранится как «8.1.1», остальные —
 * «8.1.1_N»; отсутствующая в архиве табличка рисуется на листе программно.
 */
function distancePlate(metres: number | null, marker: DistanceField): string {
  if (metres === null)
    throw new TemplateBuildError(
      `На этапе 2 укажите расстояние «${distanceTitles[marker]}»: по нему подписывается табличка 8.1.1 у знака 2.6.`,
    )
  if (!Number.isInteger(metres) || metres <= 0)
    throw new TemplateBuildError(
      `Расстояние «${distanceTitles[marker]}» для таблички 8.1.1 укажите целым числом метров.`,
    )
  return metres === 300 ? '8.1.1' : `8.1.1_${metres}`
}

/**
 * Промежуточные ступени скорости в населённом пункте: шаг не более `stepKmh` (нормативный
 * параметр «шаг ступенчатого ограничения», ГОСТ Р 52289, п. 5.4.22) до скорости в зоне.
 */
export function settlementSteps(approachKmh: number, zoneKmh: number, stepKmh = 20): number[] {
  const steps: number[] = []
  let current = approachKmh
  while (current - zoneKmh > stepKmh) {
    current -= stepKmh
    steps.push(current)
  }
  return steps
}

/**
 * Builds only schematic objects. Состав стоек повторяет рисунки Б.33/Б.34 ОДМ 218.6.019-2016:
 * предупреждение 1.25, ступени скорости 3.24 с запретом обгона 3.20, сужение 1.20.2/1.20.3,
 * знак 1.25 с табличкой 8.2.1 у начала работ, конец ограничений 3.31; для Б.34 со знаками
 * приоритета — 2.6 с табличкой 8.1.1 и 2.7. Generated objects can be rebuilt without touching
 * manual edits.
 */
export function buildTemplatePlacements(
  scheme: Scheme,
  rules: NormativeRules = PROTOTYPE_RULES,
): Placement[] {
  checkConditions(scheme, rules)
  const { parameters, template } = scheme
  const shortFront = template.code === 'b34'
  const priority = shortFront && parameters.regulation.mode === 'signs'
  const yellow = (code: string): string => (parameters.yellowTemporarySigns ? `${code}_ж` : code)
  // В архиве знак 3.24 со значением 50 хранится как «3.24», остальные — «3.24_N».
  const speed = (kmh: number): string => {
    if (!Number.isInteger(kmh))
      throw new TemplateBuildError('Скорости для знаков 3.24 укажите целыми числами км/ч.')
    return yellow(kmh === 50 ? '3.24' : `3.24_${kmh}`)
  }
  const [first, second, zone] = parameters.speedStagesKmh
  const entry = priority ? [yellow('2.6'), '8.2.1', '1.25'] : ['8.2.1', '1.25']
  const exit = priority ? ['1.25', '8.2.1', '2.7'] : ['1.25', '8.2.1']
  const distances = parameters.signDistancesMetres

  let id = Math.max(scheme.nextPlacementId, 1 + Math.max(0, ...scheme.placements.map((p) => p.id)))
  const placements: Placement[] = []
  /**
   * Места стоек называются по смыслу, а не по порядку: при переходе между раскладками
   * (вне/в населённом пункте, знаки/регулировщики) ручная правка заменяет только ту же стойку.
   */
  const post = (
    slot: `${'L' | 'R'}:${'warning' | 'speed1' | 'narrowing' | 'zone-speed' | 'start' | 'end'}`,
    signIds: string[],
    anchor: 'L0' | 'E',
    offsetXSvg: number,
    side: 'up' | 'down',
    stand: 'left' | 'right',
    distanceLabel: string | null,
  ): void => {
    placements.push({
      kind: 'sign-post',
      id: id++,
      generatedByTemplate: true,
      templateSlot: `post2:${slot}`,
      position: { anchor, offsetXSvg, offsetYSvg: 0 },
      side,
      stand,
      signIds,
      distanceLabel,
    })
  }

  if (parameters.location === 'out') {
    const { before, after } =
      draftTemplateProfile.offsets.outside[priority ? 'priority' : 'regular']
    // Подход слева (нижняя полоса): 300 → 250 → 150 → 50 → 0 м.
    post('L:warning', ['1.25'], 'L0', before[0], 'down', 'left', '{d300}')
    post('L:speed1', [speed(first), yellow('3.20')], 'L0', before[1], 'down', 'left', '{d250}')
    post(
      'L:narrowing',
      priority
        ? [speed(second), yellow('1.20.2'), yellow('2.6'), distancePlate(distances.d150, 'd150')]
        : [speed(second), yellow('1.20.2')],
      'L0',
      before[2],
      'down',
      'left',
      '{d150}',
    )
    post('L:zone-speed', [speed(zone)], 'L0', before[3], 'down', 'left', '{d50}')
    post('L:start', entry, 'L0', -2, 'down', 'right', '0')
    post('L:end', [yellow('3.20'), '3.31'], 'L0', before[1], 'up', 'left', null)
    // Подход справа (верхняя полоса): 0 → 50 → 150 → 250 → 300 м.
    post('R:start', exit, 'E', 2, 'up', 'left', '0')
    post('R:zone-speed', [speed(zone)], 'E', after[0], 'up', 'right', '{d50}')
    post('R:narrowing', [yellow('1.20.3'), speed(second)], 'E', after[1], 'up', 'right', '{d150}')
    post('R:speed1', [yellow('3.20'), speed(first)], 'E', after[2], 'up', 'right', '{d250}')
    post('R:warning', ['1.25'], 'E', after[3], 'up', 'right', '{d300}')
    post('R:end', ['3.31', yellow('3.20')], 'E', after[2], 'down', 'right', null)
  } else {
    const layout = draftTemplateProfile.offsets.settlement[priority ? 'priority' : 'regular']
    const steps = settlementSteps(parameters.approachSpeedKmh!, zone, rules.speedStepKmh).map(speed)
    post('L:warning', ['1.25', ...steps], 'L0', layout.far, 'down', 'left', '{n100}')
    post(
      'L:narrowing',
      priority
        ? [
            speed(zone),
            yellow('3.20'),
            yellow('1.20.2'),
            yellow('2.6'),
            distancePlate(distances.n50, 'n50'),
          ]
        : [speed(zone), yellow('3.20'), yellow('1.20.2')],
      'L0',
      layout.near,
      'down',
      'left',
      '{n50}',
    )
    post('L:start', entry, 'L0', -2, 'down', 'right', '0')
    post('L:end', [yellow('3.20'), '3.31'], 'L0', layout.near, 'up', 'left', null)
    post('R:start', exit, 'E', 2, 'up', 'left', '0')
    post(
      'R:narrowing',
      [yellow('1.20.3'), yellow('3.20'), speed(zone)],
      'E',
      layout.afterNear,
      'up',
      'right',
      '{n50}',
    )
    post(
      'R:warning',
      [...[...steps].reverse(), '1.25'],
      'E',
      layout.afterFar,
      'up',
      'right',
      '{n100}',
    )
    post('R:end', ['3.31', yellow('3.20')], 'E', layout.afterNear, 'down', 'right', null)
  }

  const element = (
    kind: 'complex' | 'car' | 'reg' | 'pit',
    anchor: 'L0' | 'L1' | 'Z0' | 'Z1' | 'E',
    offsetXSvg: number,
    ySvg: number,
    width: number,
    height: number,
    zoneFraction?: number,
  ): void => {
    placements.push({
      kind: 'element',
      id: id++,
      generatedByTemplate: true,
      templateSlot: `${kind}2:${anchor}:${zoneFraction ?? offsetXSvg}`,
      elementKind: kind,
      position: {
        anchor,
        offsetXSvg,
        ySvg,
        ...(zoneFraction === undefined ? {} : { zoneFraction }),
      },
      sizeSvg: { width, height },
      text: null,
      fontSizeSvg: null,
      bold: false,
    })
  }
  // Переносной комплекс перед отводом и машина прикрытия у начала зоны (рис. Б.33, Б.34).
  element('complex', 'L0', -48, 486, 46, 40)
  element('car', 'L1', 6, 474, 58, 58)
  // Два регулировщика — у начала и конца места работ (ОДМ 218.6.019-2016, п. 12.7.2), каждый
  // не ближе расстояния по табл. 5 до рабочей зоны (Z0–Z1) со стороны своего направления.
  // Для движения справа начало рабочей зоны — Z1: регулировщик стоит правее неё.
  const anchors = anchorCoordinates(scheme)
  const workZone = parameters.workZones[template.code]
  const unitsPerMetre = workZone ? (anchors.Z1 - anchors.Z0) / workZone.workMetres : 0
  const regulatorMetres = rules.regulatorDistance[zone] ?? null
  const regulatorUnits = regulatorMetres === null ? 0 : Math.round(regulatorMetres * unitsPerMetre)
  const twoRegulators = (leftPrototype: number, rightMargin: number, topY: number): void => {
    // Слева: у начала отвода, но не ближе табл. 5 до Z0.
    const leftX = Math.min(anchors.L0 + leftPrototype, anchors.Z0 - regulatorUnits)
    element('reg', 'L0', Math.round(leftX - anchors.L0), 518, 22, 30)
    // Справа: за концом места работ (E) и не ближе табл. 5 от Z1.
    const rightX = Math.max(anchors.E + rightMargin, anchors.Z1 + regulatorUnits)
    element('reg', 'E', Math.round(rightX - anchors.E), topY, 22, 30)
  }
  if (!shortFront) {
    twoRegulators(-95, 70, 368)
  } else {
    element('complex', 'Z1', -22, 462, 46, 40)
    if (parameters.frontStyle !== 'solid')
      for (const [fraction, y, width, height] of [
        [0.06, 478, 40, 18],
        [0.32, 490, 28, 18],
        [0.56, 480, 32, 16],
        [0.78, 491, 24, 17],
      ] as const)
        element('pit', 'Z0', 0, y, width, height, fraction)
    if (parameters.regulation.mode === 'one') element('reg', 'Z0', -11, 366, 22, 30, 0.25)
    if (parameters.regulation.mode === 'two') twoRegulators(-100, 40, 366)
  }
  return placements
}

export function rebuildTemplatePlacements(
  scheme: Scheme,
  rules: NormativeRules = PROTOTYPE_RULES,
): {
  scheme: Scheme
  keptSlots: number
  /** Вручную изменённые объекты прежней версии шаблона: у них нет места в новой раскладке. */
  staleSlots: number
} {
  const manual = scheme.placements.filter((placement) => !placement.generatedByTemplate)
  const taken = new Set(manual.flatMap((placement) => placement.templateSlot ?? []))
  const built = buildTemplatePlacements({ ...scheme, placements: manual }, rules)
  const current = new Set(built.flatMap((placement) => placement.templateSlot ?? []))
  const generated = built.filter(
    (placement) => !placement.templateSlot || !taken.has(placement.templateSlot),
  )
  return {
    scheme: schemeSchema.parse({
      ...scheme,
      template: { ...scheme.template, projectionVersion: draftTemplateProfile.id },
      placements: [...manual, ...generated],
      nextPlacementId: Math.max(
        scheme.nextPlacementId,
        ...generated.map((placement) => placement.id + 1),
      ),
    }),
    keptSlots: [...taken].filter((slot) => current.has(slot)).length,
    staleSlots: [...taken].filter((slot) => !current.has(slot)).length,
  }
}
