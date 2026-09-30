import type { Scheme } from '../../src/domain/model'
import { responsibleLine } from '../../src/domain/title-block'

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
  const { approachSpeedKmh, ...parameters } = scheme.parameters
  return {
    ...scheme,
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
  const { signImages: _signImages, reviewMarks: _marks, ...oldBase } = scheme
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
    placements: scheme.placements.map((placement) => {
      if (placement.kind !== 'element') return placement
      const { anchor, offsetXSvg, ySvg } = placement.position
      return { ...placement, position: { anchor, offsetXSvg, ySvg } }
    }),
  }
}
