import type { Scheme } from '../../src/domain/model'

/** Reconstruct the shape of old saved snapshots for migration tests. */
export function oldSnapshot(scheme: Scheme, schemaVersion: 2 | 3 | 4) {
  const parameters = scheme.parameters
  const { signImages: _signImages, ...oldBase } = scheme
  void _signImages
  return {
    ...oldBase,
    schemaVersion,
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
