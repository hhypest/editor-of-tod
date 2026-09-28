import { schemeSchema, type Scheme } from './model'

type Placement = Scheme['placements'][number]

/** Sources for a preliminary drawing profile, not a statement that a project complies. */
export const draftTemplateProfile = {
  id: 'draft-1',
  source: 'ОДМ 218.6.019-2016',
  clauses: {
    figures: 'Приложение Б, рисунки Б.33 и Б.34 (стр. 100–101)',
    roadworks: '8.1.2.2',
    priority: '4.1.8.3, 5.4.4, 8.1.3.1',
    regulators: '12.7.2–12.7.3, таблица 5',
  },
  // These are coordinates on a 1680 × 1188 drawing. They are not distances on the road.
  approachXs: { left: [60, 155, 250, 345, 440], right: [1190, 1285, 1380, 1475, 1570] },
} as const

export class TemplateBuildError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TemplateBuildError'
  }
}

function checkConditions(scheme: Scheme): void {
  const { parameters, template } = scheme
  if (parameters.location === 'auto') {
    throw new TemplateBuildError('На этапе 2 укажите, находится ли переезд в населённом пункте.')
  }
  if (template.code !== 'b34') return
  const { regulation } = parameters
  if (regulation.mode === 'auto') {
    throw new TemplateBuildError(
      'На этапе 2 выберите способ регулирования Б.34 после оценки условий.',
    )
  }
  if (regulation.mode === 'signs') {
    const hourly = Number(regulation.hourly.trim().replace(',', '.'))
    if (!Number.isFinite(hourly) || hourly < 0 || hourly >= 250 || regulation.vis) {
      throw new TemplateBuildError(
        'Для варианта со знаками 2.6/2.7 укажите интенсивность менее 250 авт./ч и подтвердите достаточную видимость (ОДМ, п. 5.4.4).',
      )
    }
    if (parameters.workZones.b34?.taperMetres !== 15) {
      throw new TemplateBuildError(
        'Для знаков 2.6/2.7 проверьте и укажите отгон 15 м (ОДМ, п. 4.1.8.3).',
      )
    }
  }
  if (regulation.mode === 'one' && (!regulation.straight || regulation.vis)) {
    throw new TemplateBuildError(
      'Один регулировщик возможен после подтверждения прямого участка и видимости с двух сторон (ОДМ, п. 12.7.3).',
    )
  }
}

/** Builds only schematic objects. Generated objects can be rebuilt without touching manual edits. */
export function buildTemplatePlacements(scheme: Scheme): Placement[] {
  checkConditions(scheme)
  const { parameters, template } = scheme
  const priority = template.code === 'b34' && parameters.regulation.mode === 'signs'
  const distanceKeys =
    parameters.location === 'in'
      ? (['n100', 'n50'] as const)
      : (['d300', 'd250', 'd150', 'd50'] as const)
  const speedCode = (speed: number): string => {
    const suffix = parameters.yellowTemporarySigns ? '_ж' : ''
    return Number.isInteger(speed) ? `3.24_${speed}${suffix}` : '3.24'
  }
  const signs = [
    '1.25',
    speedCode(parameters.speedStagesKmh[0]),
    speedCode(parameters.speedStagesKmh[1]),
    speedCode(parameters.speedStagesKmh[2]),
    priority ? '2.6' : '1.20.2',
  ]
  let id = Math.max(scheme.nextPlacementId, 1 + Math.max(0, ...scheme.placements.map((p) => p.id)))
  const makePost = (x: number, side: 'up' | 'down', index: number): Placement => ({
    kind: 'sign-post',
    id: id++,
    generatedByTemplate: true,
    position: { anchor: 'abs', offsetXSvg: x, offsetYSvg: 0 },
    side,
    stand: side === 'up' ? 'left' : 'right',
    signIds: [side === 'down' && priority && index === 4 ? '2.7' : signs[index]!],
    distanceLabel: index < distanceKeys.length ? `{${distanceKeys[index]}}` : null,
  })
  const placements: Placement[] = [
    ...draftTemplateProfile.approachXs.left.map((x, index) => makePost(x, 'up', index)),
    ...draftTemplateProfile.approachXs.right.map((x, index) => makePost(x, 'down', 4 - index)),
  ]
  function element(
    kind: 'cone' | 'pit' | 'reg' | 'car',
    anchor: 'Z0' | 'Z1' | 'AX',
    offsetXSvg: number,
    ySvg: number,
    zoneFraction?: number,
  ): void {
    placements.push({
      kind: 'element',
      id: id++,
      generatedByTemplate: true,
      elementKind: kind,
      position: {
        anchor,
        offsetXSvg,
        ySvg,
        ...(zoneFraction === undefined ? {} : { zoneFraction }),
      },
      sizeSvg:
        kind === 'car'
          ? { width: 82, height: 48 }
          : kind === 'reg'
            ? { width: 28, height: 50 }
            : kind === 'pit'
              ? { width: 20, height: 16 }
              : { width: 12, height: 18 },
      text: null,
      fontSizeSvg: null,
      bold: false,
    })
  }
  for (const fraction of [0, 0.33, 0.66, 0.94]) {
    element('cone', 'Z0', 0, 434, fraction)
    element('pit', 'Z0', 0, 482, fraction)
  }
  element('car', 'Z0', -95, 520)
  if (template.code === 'b33' || parameters.regulation.mode === 'two') {
    element('reg', 'Z0', -85, 362)
    element('reg', 'Z1', 55, 560)
  } else if (parameters.regulation.mode === 'one') {
    element('reg', 'AX', 0, 335)
  }
  return placements
}

export function rebuildTemplatePlacements(scheme: Scheme): Scheme {
  const manual = scheme.placements.filter((placement) => !placement.generatedByTemplate)
  const generated = buildTemplatePlacements({ ...scheme, placements: manual })
  return schemeSchema.parse({
    ...scheme,
    placements: [...manual, ...generated],
    nextPlacementId: Math.max(...generated.map((placement) => placement.id)) + 1,
  })
}
