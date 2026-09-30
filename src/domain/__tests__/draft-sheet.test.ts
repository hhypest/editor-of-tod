import { describe, expect, it } from 'vitest'
import b33 from '../../../tests/fixtures/manual-v1.json?raw'
import b34 from '../../../tests/fixtures/legacy-b34-manual.json?raw'
import { createUnlinkedScheme } from '../create-scheme'
import { applySchemeDetails, createSchemeDetailsDraft } from '../edit-details'
import { newSignDraft, newTextDraft, savePlacement } from '../edit-placements'
import { projectDraftSheet } from '../draft-sheet'
import { importSchemeJson } from '../import'
import { linkPu66Card } from '../link-pu66'

function nativeScheme() {
  return createUnlinkedScheme({
    referenceId: 'TEST-SHEET',
    locationText: 'Учебный участок',
    directionLeft: 'А',
    directionRight: 'Б',
    frontMetres: '18',
    taperMetres: '8',
    bufferMetres: '12',
    speedStagesKmh: ['70', '50', '40'],
    location: 'out',
    approachSpeedKmh: '90',
    yellowTemporarySigns: false,
  })
}

describe('provisional print projection', () => {
  it('keeps imported B.33/B.34 coordinates, object order and text without modifying the project', () => {
    for (const raw of [b33, b34]) {
      const scheme = importSchemeJson(raw).scheme
      const original = structuredClone(scheme)
      const sheet = projectDraftSheet(scheme)
      expect(sheet.template).toBe(scheme.template.code)
      expect(sheet.placements.map((item) => item.id)).toEqual(
        scheme.placements.map((item) => item.id),
      )
      expect(sheet.zoneStartX).toBeLessThan(sheet.zoneEndX)
      expect(sheet.zoneLabels).toEqual(scheme.parameters.workZones[scheme.template.code]?.labels)
      expect(sheet.dimensionChain.map((part) => part.enteredMetres)).toEqual(
        sheet.template === 'b33'
          ? [sheet.taper, sheet.buffer, sheet.front, sheet.taper]
          : [sheet.taper, sheet.buffer, sheet.front],
      )
      expect(
        sheet.placements.filter((item) => item.kind === 'element').map((item) => item.text),
      ).toEqual(
        scheme.placements.filter((item) => item.kind === 'element').map((item) => item.text),
      )
      expect(scheme).toEqual(original)
    }
    expect(projectDraftSheet(importSchemeJson(b33).scheme).placements[0]).toMatchObject({
      kind: 'sign-post',
      x: 20,
      y: 579,
    })
  })

  it('substitutes only entered distance markers and reflects applied edits', () => {
    const post = newSignDraft()
    if (post.kind !== 'sign-post') throw new Error('Expected sign draft')
    post.signCodes = '1.25'
    post.distanceLabel = '{d300} / {d50} / {other}'
    const withPost = savePlacement(nativeScheme(), post)
    const draft = createSchemeDetailsDraft(withPost)
    draft.parameters.signDistancesMetres.d300 = '280'
    draft.parameters.signDistancesMetres.d50 = ''
    const edited = applySchemeDetails(withPost, draft)
    expect(projectDraftSheet(edited).placements[0]).toMatchObject({
      distanceLabel: '280 м / {d50} / {other}',
    })
    // Новый проект получает расстояния по нормативным параметрам.
    expect(projectDraftSheet(withPost).placements[0]).toMatchObject({
      distanceLabel: '300 м / 50 м / {other}',
    })
  })

  it('projects only the selected PU-66 fields and never the source JSON onto the sheet', () => {
    const legacy = importSchemeJson(b33).scheme
    const withPrivateSource = {
      ...legacy,
      source: {
        kind: 'legacy-html-v1' as const,
        importedAt: legacy.createdAt,
        originalJson: 'PRIVATE-RAW-TABLE',
      },
    }
    expect(JSON.stringify(projectDraftSheet(withPrivateSource))).not.toContain('PRIVATE-RAW-TABLE')

    const linked = linkPu66Card(nativeScheme(), {
      referenceId: 'TEST-PU66',
      location: 'Учебный переезд',
      axisLabel: '12 км 3 пк',
      roadName: 'Условная дорога',
      crossingWidthMetres: 8,
      revision: 17,
      updatedAt: '2026-09-25T12:00:00.000Z',
    })
    const sheet = projectDraftSheet(linked)
    expect(sheet.referenceId).toBe('TEST-PU66')
    expect(sheet.crossingFromPu66).toEqual({
      location: 'Учебный переезд',
      axisLabel: '12 км 3 пк',
      roadName: 'Условная дорога',
      carriagewayWidthMetres: '8',
    })
    expect(projectDraftSheet(nativeScheme()).crossingFromPu66).toBeNull()
    expect(JSON.stringify(sheet)).not.toContain('2026-09-25T12:00:00.000Z')
  })

  it('identifies placed elements outside the drawing rather than silently cropping them', () => {
    const text = newTextDraft()
    if (text.kind !== 'element') throw new Error('Expected text draft')
    text.text = 'Условная надпись'
    text.x = '1700'
    const scheme = savePlacement(nativeScheme(), text)
    expect(projectDraftSheet(scheme).outsideIds).toEqual([1])
    expect(projectDraftSheet(nativeScheme()).outsideIds).toEqual([])
  })
})
