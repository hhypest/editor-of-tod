import { decimalComma, decimalCommaInMeasures } from './number-format'
import type { Scheme } from './model'
import { postCaption } from './post-distance'
import { PROTOTYPE_RULES, type NormativeRules } from './normative-parameters'
import { responsibleLine } from './title-block'
import { figureDimensions, type FigureDimension } from './figure-dimensions'
import {
  type anchorCoordinates,
  schemeLayout,
  WORKSPACE_HEIGHT,
  WORKSPACE_WIDTH,
} from './placement-workspace'

type SheetPost = {
  kind: 'sign-post'
  id: number
  x: number
  y: number
  signIds: string[]
  distanceLabel: string | null
  side: 'up' | 'down'
  stand: 'left' | 'right'
  /** Вертикальный сдвиг стойки относительно своей стороны дороги. */
  dy: number
}

type SheetElement = {
  kind: 'element'
  id: number
  x: number
  y: number
  width: number
  height: number
  elementKind: Extract<Scheme['placements'][number], { kind: 'element' }>['elementKind']
  text: string | null
  fontSize: number
  bold: boolean
}

export type DraftSheet = {
  id: string
  createdAt: string
  referenceId: string
  template: 'b33' | 'b34'
  location: string
  crossingFromPu66: {
    location: string
    axisLabel: string
    roadName: string
    carriagewayWidthMetres: string
  } | null
  directions: { left: string; right: string }
  front: number
  taper: number
  buffer: number
  zoneLabels: { taper: string; buffer: string; work: string }
  dimensionChain: FigureDimension[]
  speeds: number[]
  distances: Array<{ label: string; value: number | null }>
  yellowTemporarySigns: boolean
  frontStyle: Scheme['parameters']['frontStyle']
  zoneStartX: number
  zoneEndX: number
  axisX: number
  anchors: ReturnType<typeof anchorCoordinates>
  regulationMode: Scheme['parameters']['regulation']['mode']
  workConditions: Scheme['parameters']['workConditions']
  /**
   * Расстояние от регулировщика до рабочей зоны по табл. 5 ОДМ для скорости в зоне и его
   * источник; null — скорости нет в таблице.
   */
  regulatorDistance: { metres: number; source: string } | null
  settlement: Scheme['parameters']['location']
  signSize: Scheme['parameters']['signSize']
  titleBlock: Scheme['titleBlock']
  titleRows: Array<{ label: string; value: string }>
  placements: Array<SheetPost | SheetElement>
  outsideIds: number[]
}

function renderDistanceLabel(
  label: string | null,
  distances: Scheme['parameters']['signDistancesMetres'],
): string | null {
  if (label === null) return null
  // Подставленное расстояние — с десятичной запятой; в тексте составителя запятая ставится
  // только у чисел с единицей длины, ссылки на пункты («п. 5.2.2») остаются как введены.
  return decimalCommaInMeasures(label).replace(/\{(\w+)\}/g, (marker, key: string) => {
    const value = Object.prototype.hasOwnProperty.call(distances, key)
      ? distances[key as keyof typeof distances]
      : null
    return value === null ? marker : `${decimalComma(value)} м`
  })
}

/** Whitelist of fields used on a provisional A4 sheet; never include the whole PU-66 snapshot or legacy source. */
export function projectDraftSheet(
  scheme: Scheme,
  rules: NormativeRules = PROTOTYPE_RULES,
): DraftSheet {
  const zone = scheme.parameters.workZones[scheme.template.code]
  if (!zone) throw new Error('Размеры выбранного варианта не заполнены.')
  const { anchors, coordinates } = schemeLayout(scheme)
  const placements: DraftSheet['placements'] = scheme.placements.map((placement) => {
    const { x, y } = coordinates(placement)
    if (placement.kind === 'sign-post') {
      return {
        kind: 'sign-post',
        id: placement.id,
        x,
        y,
        signIds: [...placement.signIds],
        distanceLabel: placement.distance
          ? postCaption(placement.distance, scheme.parameters.signDistancesMetres)
          : renderDistanceLabel(placement.distanceLabel, scheme.parameters.signDistancesMetres),
        side: placement.side,
        stand: placement.stand,
        dy: placement.position.offsetYSvg,
      }
    }
    return {
      kind: 'element',
      id: placement.id,
      x,
      y,
      width: placement.sizeSvg.width,
      height: placement.sizeSvg.height,
      elementKind: placement.elementKind,
      text: placement.text,
      fontSize: placement.fontSizeSvg ?? 14,
      bold: placement.bold,
    }
  })

  return {
    id: scheme.id,
    createdAt: scheme.createdAt,
    referenceId: scheme.crossing.referenceId,
    template: scheme.template.code,
    location: scheme.parameters.locationText,
    crossingFromPu66:
      scheme.crossing.source === 'local-pu66'
        ? {
            location: scheme.crossing.snapshot.location,
            axisLabel: scheme.crossing.snapshot.axisLabel,
            roadName: scheme.crossing.snapshot.roadName,
            carriagewayWidthMetres:
              scheme.crossing.snapshot.crossingWidthMetres === null
                ? ''
                : decimalComma(String(scheme.crossing.snapshot.crossingWidthMetres).trim()),
          }
        : null,
    directions: { ...scheme.parameters.directions },
    front: zone.workMetres,
    taper: zone.taperMetres,
    buffer: zone.bufferMetres,
    zoneLabels: { ...zone.labels },
    dimensionChain: figureDimensions(scheme),
    speeds: [...scheme.parameters.speedStagesKmh],
    distances: (['d300', 'd250', 'd150', 'd50', 'n100', 'n50'] as const).map((label) => ({
      label,
      value: scheme.parameters.signDistancesMetres[label],
    })),
    yellowTemporarySigns: scheme.parameters.yellowTemporarySigns,
    frontStyle: scheme.parameters.frontStyle,
    zoneStartX: anchors.Z0,
    zoneEndX: anchors.Z1,
    axisX: anchors.AX,
    anchors,
    regulationMode: scheme.parameters.regulation.mode,
    workConditions: { ...scheme.parameters.workConditions },
    regulatorDistance: (() => {
      const metres = rules.regulatorDistance[scheme.parameters.speedStagesKmh[2]]
      return metres === undefined
        ? null
        : { metres, source: rules.sources['odm-regulator-distance'] ?? 'ОДМ 218.6.019, табл. 5' }
    })(),
    settlement: scheme.parameters.location,
    signSize: scheme.parameters.signSize,
    titleBlock: JSON.parse(JSON.stringify(scheme.titleBlock)) as Scheme['titleBlock'],
    placements,
    titleRows: [
      {
        label: 'Разработчик',
        value: [
          scheme.titleBlock.developer.organization,
          scheme.titleBlock.developer.position,
          scheme.titleBlock.developer.name,
        ]
          .filter(Boolean)
          .join(' · '),
      },
      { label: 'Дата разработки', value: scheme.titleBlock.developer.date },
      {
        label: 'Работы',
        value: [scheme.titleBlock.work.organization, scheme.titleBlock.work.description]
          .filter(Boolean)
          .join(' · '),
      },
      { label: 'Период', value: scheme.titleBlock.work.period },
      {
        label: 'Ответственные',
        value: scheme.titleBlock.responsible.map(responsibleLine).filter(Boolean).join(' · '),
      },
      {
        label: 'Владелец дороги',
        value: [
          scheme.titleBlock.approver.position,
          scheme.titleBlock.approver.organization,
          scheme.titleBlock.approver.name,
        ]
          .filter(Boolean)
          .join(' · '),
      },
      {
        label: 'Госавтоинспекция',
        value: [
          scheme.titleBlock.agreement.position,
          scheme.titleBlock.agreement.name,
          scheme.titleBlock.agreement.year,
        ]
          .filter(Boolean)
          .join(' · '),
      },
    ],
    outsideIds: placements
      .filter(
        (placement) =>
          placement.x < 0 ||
          placement.x > WORKSPACE_WIDTH ||
          placement.y < 0 ||
          placement.y > WORKSPACE_HEIGHT ||
          (placement.kind === 'element' &&
            (placement.x + placement.width > WORKSPACE_WIDTH ||
              placement.y + placement.height > WORKSPACE_HEIGHT)),
      )
      .map((placement) => placement.id),
  }
}
