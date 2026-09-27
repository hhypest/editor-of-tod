import type { Scheme } from './model'
import {
  anchorCoordinates,
  placementCoordinates,
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
  speeds: number[]
  distances: Array<{ label: string; value: number | null }>
  yellowTemporarySigns: boolean
  zoneStartX: number
  zoneEndX: number
  axisX: number
  titleRows: Array<{ label: string; value: string }>
  placements: Array<SheetPost | SheetElement>
  outsideIds: number[]
}

function renderDistanceLabel(
  label: string | null,
  distances: Scheme['parameters']['signDistancesMetres'],
): string | null {
  if (label === null) return null
  return label.replace(/\{(d300|d250|d150|d50)\}/g, (marker, key: keyof typeof distances) => {
    const value = distances[key]
    return value === null ? marker : `${value} м`
  })
}

/** Whitelist of fields used on a provisional A4 sheet; never include the whole PU-66 snapshot or legacy source. */
export function projectDraftSheet(scheme: Scheme): DraftSheet {
  const zone = scheme.parameters.workZones[scheme.template.code]
  if (!zone) throw new Error('Размеры выбранного варианта не заполнены.')
  const anchors = anchorCoordinates(scheme)
  const placements: DraftSheet['placements'] = scheme.placements.map((placement) => {
    const { x, y } = placementCoordinates(placement, anchors)
    if (placement.kind === 'sign-post') {
      return {
        kind: 'sign-post',
        id: placement.id,
        x,
        y,
        signIds: [...placement.signIds],
        distanceLabel: renderDistanceLabel(
          placement.distanceLabel,
          scheme.parameters.signDistancesMetres,
        ),
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
                : String(scheme.crossing.snapshot.crossingWidthMetres).trim(),
          }
        : null,
    directions: { ...scheme.parameters.directions },
    front: zone.workMetres,
    taper: zone.taperMetres,
    buffer: zone.bufferMetres,
    zoneLabels: { ...zone.labels },
    speeds: [...scheme.parameters.speedStagesKmh],
    distances: (['d300', 'd250', 'd150', 'd50'] as const).map((label) => ({
      label,
      value: scheme.parameters.signDistancesMetres[label],
    })),
    yellowTemporarySigns: scheme.parameters.yellowTemporarySigns,
    zoneStartX: anchors.Z0,
    zoneEndX: anchors.Z1,
    axisX: anchors.AX,
    placements,
    titleRows: [
      {
        label: 'Разработчик',
        value: [scheme.titleBlock.developer.organization, scheme.titleBlock.developer.name]
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
      { label: 'Ответственные', value: scheme.titleBlock.responsible.filter(Boolean).join(' · ') },
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
