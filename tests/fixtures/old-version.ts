import type { Scheme } from '../../src/domain/model'
import { responsibleLine } from '../../src/domain/title-block'

/**
 * Формат v9 (до Р1): у стойки нет расстояния, только подпись — маркер поля этапа 2 или текст.
 */
export function v9Snapshot(scheme: Scheme) {
  return {
    ...scheme,
    schemaVersion: 9 as const,
    placements: scheme.placements.map((placement) => {
      if (placement.kind !== 'sign-post') return placement
      const { distance, ...post } = placement
      return {
        ...post,
        distanceLabel: !distance
          ? placement.distanceLabel
          : distance.by === 'marker'
            ? `{${distance.marker}}`
            : distance.metres === 0
              ? '0'
              : `${distance.metres} м`,
      }
    }),
  }
}

/** v8 did not retain speed conditions or normative decision evidence. */
export function v8Snapshot(scheme: Scheme) {
  const { decisionEvidence: _evidence, ...rest } = v9Snapshot(scheme)
  const { speedConditions: _conditions, ...parameters } = scheme.parameters
  void _evidence
  void _conditions
  return { ...rest, schemaVersion: 8 as const, parameters }
}

/** Реквизиты в форме v1–v5: без должности разработчика, ответственные — две строки. */
export function oldTitleBlock(scheme: Scheme) {
  const { developer, responsible, ...rest } = scheme.titleBlock
  return {
    ...rest,
    developer: { organization: developer.organization, name: developer.name, date: developer.date },
    responsible: [
      responsibleLine(responsible[0]!),
      responsible[1] ? responsibleLine(responsible[1]) : '',
    ] as [string, string],
  }
}

/**
 * Снимок формата v6 (до 01.10.2026): вместо скорости на подходе — «скорость в населённом
 * пункте». Вне населённого пункта поле не использовалось, там записывается значение прототипа.
 */
export function v6Snapshot(scheme: Scheme) {
  const previous = v8Snapshot(scheme)
  const { approachSpeedKmh, workConditions: _conditions, ...parameters } = previous.parameters
  void _conditions
  return {
    ...previous,
    schemaVersion: 6 as const,
    parameters: { ...parameters, settlementSpeedKmh: approachSpeedKmh ?? 60 },
  }
}

/** Снимок формата v5 (до 30.09.2026): те же поля, кроме реквизитов и отметок проверки. */
export function v5Snapshot(scheme: Scheme) {
  const { reviewMarks: _marks, ...rest } = v6Snapshot(scheme)
  void _marks
  return { ...rest, schemaVersion: 5 as const, titleBlock: oldTitleBlock(scheme) }
}

/** Reconstruct the shape of old saved snapshots for migration tests. */
export function oldSnapshot(scheme: Scheme, schemaVersion: 2 | 3 | 4) {
  const parameters = scheme.parameters
  const { signImages: _signImages, reviewMarks: _marks, ...oldBase } = v8Snapshot(scheme)
  void _signImages
  void _marks
  return {
    ...oldBase,
    schemaVersion,
    titleBlock: oldTitleBlock(scheme),
    template: {
      code: scheme.template.code,
      sourceReference: scheme.template.sourceReference,
      reviewStatus: scheme.template.reviewStatus,
    },
    parameters: {
      locationText: parameters.locationText,
      directions: parameters.directions,
      signDistancesMetres: {
        d300: parameters.signDistancesMetres.d300,
        d250: parameters.signDistancesMetres.d250,
        d150: parameters.signDistancesMetres.d150,
        d50: parameters.signDistancesMetres.d50,
      },
      speedStagesKmh: parameters.speedStagesKmh,
      yellowTemporarySigns: parameters.yellowTemporarySigns,
      workZones: parameters.workZones,
    },
    placements: oldBase.placements.map((placement) => {
      if (placement.kind !== 'element') return placement
      const { anchor, offsetXSvg, ySvg } = placement.position
      return { ...placement, position: { anchor, offsetXSvg, ySvg } }
    }),
  }
}
