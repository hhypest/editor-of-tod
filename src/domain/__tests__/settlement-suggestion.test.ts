import { describe, expect, it } from 'vitest'
import { createUnlinkedScheme } from '../create-scheme'
import { linkPu66Card } from '../link-pu66'
import { schemeSettlementSuggestion, settlementSuggestion } from '../settlement-suggestion'

describe('settlement suggestion from a PU-66 road name', () => {
  it.each([
    ['ул. Железнодорожная', 'ул.'],
    ['город Учебный, проспект Мира', 'проспект'],
    ['Автодорога в г. Учебный', 'г.'],
    ['посёлок Станционный, переулок Лесной', 'переулок'],
  ])('suggests a settlement for %s without changing the project', (roadName, marker) => {
    expect(settlementSuggestion(roadName)).toEqual({ location: 'in', marker })
  })

  it.each([
    '',
    'Автодорога Учебная — Северная',
    'Москва — Тверь',
    'Объездная дорога',
    'перегон Учебный',
  ])('does not infer a settlement from %s', (roadName) => {
    expect(settlementSuggestion(roadName)).toBeNull()
  })

  it('uses only a pinned PU-66 snapshot', () => {
    const scheme = createUnlinkedScheme({
      referenceId: 'TEST-SETTLEMENT',
      locationText: 'Учебный участок',
      directionLeft: 'А',
      directionRight: 'Б',
      frontMetres: '18',
      taperMetres: '10',
      bufferMetres: '10',
      speedStagesKmh: ['70', '50', '40'],
      location: 'out',
      approachSpeedKmh: '90',
      yellowTemporarySigns: false,
    })
    expect(schemeSettlementSuggestion(scheme)).toBeNull()
    const linked = linkPu66Card(scheme, {
      referenceId: 'TEST-SETTLEMENT',
      location: 'Учебный километр',
      axisLabel: 'Учебная ось',
      roadName: 'ул. Железнодорожная',
      crossingWidthMetres: 8,
      crossingRoadLengthMetres: 40,
      revision: 1,
      updatedAt: '2026-10-23T12:00:00.000Z',
    })
    expect(schemeSettlementSuggestion(linked)).toEqual({ location: 'in', marker: 'ул.' })
    expect(linked.parameters.location).toBe('out')
  })
})
