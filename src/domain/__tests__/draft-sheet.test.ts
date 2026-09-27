import { describe, expect, it } from 'vitest'
import b33 from '../../../tests/fixtures/manual-v1.json?raw'
import b34 from '../../../tests/fixtures/legacy-b34-manual.json?raw'
import { createNewScheme } from '../create-scheme'
import { applySchemeDetails, createSchemeDetailsDraft } from '../edit-details'
import { newSignDraft, newTextDraft, savePlacement } from '../edit-placements'
import { projectDraftSheet } from '../draft-sheet'
import { importSchemeJson } from '../import'
import { linkPu66Card } from '../link-pu66'

function nativeScheme() {
  return createNewScheme({
    referenceId: 'TEST-SHEET',
    locationText: 'Учебный участок',
    directionLeft: 'А',
    directionRight: 'Б',
    frontMetres: '18',
    taperMetres: '8',
    bufferMetres: '12',
    speedStagesKmh: ['70', '50', '40'],
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
    draft.parameters.signDistancesMetres.d300 = '300'
    const edited = applySchemeDetails(withPost, draft)
    expect(projectDraftSheet(edited).placements[0]).toMatchObject({
      distanceLabel: '300 м / {d50} / {other}',
    })
    expect(projectDraftSheet(withPost).placements[0]).toMatchObject({
      distanceLabel: '{d300} / {d50} / {other}',
    })
  })

  it('does not project the confidential snapshot or the source JSON onto the sheet', () => {
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
      location: 'PRIVATE-CARD-DETAIL',
      axisLabel: 'PRIVATE-AXIS',
      roadName: 'PRIVATE-ROAD',
      crossingWidthMetres: 8,
      revision: 1,
      updatedAt: '2026-09-26T12:00:00.000Z',
    })
    const printed = JSON.stringify(projectDraftSheet(linked))
    expect(printed).toContain('TEST-PU66')
    expect(printed).not.toContain('PRIVATE-')
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
