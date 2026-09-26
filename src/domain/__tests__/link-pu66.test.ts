import { describe, expect, it } from 'vitest'
import { createNewScheme } from '../create-scheme'
import { exportSchemeJson, importSchemeJson } from '../import'
import { linkPu66Card } from '../link-pu66'
import type { Pu66SchemeRecord } from '../pu66-snapshot'

const scheme = createNewScheme({
  referenceId: 'TEST-OLD',
  locationText: 'Ручная подпись участка',
  directionLeft: '',
  directionRight: '',
  frontMetres: '18',
  taperMetres: '8',
  bufferMetres: '12',
  speedStagesKmh: ['70', '50', '40'],
  yellowTemporarySigns: false,
})

const card: Pu66SchemeRecord = {
  referenceId: 'TEST-PU66',
  location: '88 км 3 пк',
  axisLabel: '88 км 3 пк',
  roadName: 'Вымышленная дорога',
  crossingWidthMetres: 8,
  revision: 1,
  updatedAt: '2026-09-26T12:00:00.000Z',
}

describe('explicit local PU-66 link', () => {
  it('copies only the selected scheme fields and preserves all other project data', () => {
    const linked = linkPu66Card(scheme, card)
    expect(linked.crossing).toEqual({
      referenceId: card.referenceId,
      source: 'local-pu66',
      snapshot: {
        location: card.location,
        axisLabel: card.axisLabel,
        roadName: card.roadName,
        crossingWidthMetres: 8,
        revision: 1,
        updatedAt: card.updatedAt,
      },
    })
    expect(linked.id).toBe(scheme.id)
    expect(linked.createdAt).toBe(scheme.createdAt)
    expect(linked.parameters).toEqual(scheme.parameters)
    expect(linked.placements).toEqual(scheme.placements)
    expect(scheme.crossing).toMatchObject({ referenceId: 'TEST-OLD', snapshot: null })
    expect(importSchemeJson(exportSchemeJson(linked)).scheme).toEqual(linked)
  })

  it('does not change the older snapshot when a newer card is explicitly selected', () => {
    const original = linkPu66Card(scheme, card)
    const updated = linkPu66Card(original, { ...card, revision: 2, roadName: 'Уточнённая дорога' })
    expect(original.crossing.snapshot?.revision).toBe(1)
    expect(updated.crossing.snapshot?.revision).toBe(2)
    expect(updated.crossing.snapshot?.roadName).toBe('Уточнённая дорога')
  })

  it('rejects extra fields from the confidential full card', () => {
    const fullCard = { ...card, technicalRows: [{ item: '1' }] }
    expect(() => linkPu66Card(scheme, fullCard)).toThrow()
  })
})
