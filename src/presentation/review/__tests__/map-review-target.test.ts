import { describe, expect, it } from 'vitest'
import { mapReviewTarget } from '../map-review-target'

describe('review navigation adapter', () => {
  it('opens the document library for a PDD check blocked by a missing edition', () => {
    expect(
      mapReviewTarget({
        id: 'pdd-speed',
        path: 'parameters.approachSpeedKmh',
        markBlocked: 'Нет редакции',
      }),
    ).toEqual({ view: 'registries', sectionId: 'documents-title', registryTab: 'documents' })
    expect(mapReviewTarget({ id: 'pdd-speed', path: 'parameters.approachSpeedKmh' }).view).toBe(
      'geometry',
    )
  })
  it.each([
    ['place', 'parameters.locationText', 'source', 'details-title', 'parameters.locationText'],
    [
      'place',
      'parameters.directions.left',
      'source',
      'details-title',
      'parameters.directions.left',
    ],
    [
      'distance-d150',
      'parameters.signDistancesMetres.d150',
      'geometry',
      'details-title',
      'parameters.signDistancesMetres.d150',
    ],
    [
      'developer',
      'titleBlock.developer.position',
      'review',
      'details-title',
      'titleBlock.developer.position',
    ],
    ['figure-dimensions', 'parameters', 'geometry', 'details-title', undefined],
    ['crossing', 'crossing', 'source', 'pu66-link-title', undefined],
    ['pu66-status', 'crossing', 'source', 'pu66-link-title', undefined],
    [
      'decision-speed',
      'decisionEvidence.speed',
      'geometry',
      'details-title',
      'decisionEvidence.speed',
    ],
    [
      'decision-regulation',
      'decisionEvidence.regulation',
      'geometry',
      'details-title',
      'decisionEvidence.regulation',
    ],
    ['b34-traffic', 'placements', 'objects', 'placements-title', undefined],
  ] as const)('maps %s by semantic path', (id, path, view, sectionId, field) => {
    expect(mapReviewTarget({ id, path })).toEqual({ view, sectionId, ...(field ? { field } : {}) })
  })

  it('opens sign imports and uses a stable fallback for an unknown path', () => {
    expect(mapReviewTarget({ id: 'signs', path: 'signImages' })).toEqual({
      view: 'registries',
      sectionId: 'imported-title',
      registryTab: 'imports',
    })
    expect(mapReviewTarget({ id: 'future-check', path: 'futureData' })).toEqual({
      view: 'review',
      sectionId: 'review-title',
    })
    expect(mapReviewTarget({ id: 'future-check', path: 'parameters.approachSpeedKmh' }).field).toBe(
      'parameters.approachSpeedKmh',
    )
  })
})
