import { describe, expect, it } from 'vitest'
import { importSchemeJson } from '../import'
import { reviewScheme } from '../review-scheme'
import { findingFingerprint } from '../review-marks'
import { projectDraftSheet } from '../draft-sheet'
import { drawSheet } from '../sheet-drawing'

const fixtures = import.meta.glob<string>('../../../tests/fixtures/*.json', {
  query: '?raw',
  import: 'default',
  eager: true,
})

// Captured before A3: UI destinations are intentionally outside the persisted review contract.
describe('review and drawing baseline before A3', () => {
  for (const [name, json] of Object.entries(fixtures)) {
    it(`preserves findings, acknowledgment fingerprints and sheet nodes: ${name}`, async () => {
      const scheme = importSchemeJson(json, {
        id: '55740b36-080a-4cbe-9476-e71ffb1ab47f',
        now: '2026-10-02T12:00:00.000Z',
      }).scheme
      const reviewed = reviewScheme(scheme)
      for (const finding of reviewed) {
        expect(finding.path).not.toContain('#')
        expect(finding).not.toHaveProperty('target')
        expect(finding).not.toHaveProperty('field')
      }
      const findings = reviewed.map((finding) => ({
        id: finding.id,
        kind: finding.kind,
        fingerprint: findingFingerprint(finding),
        markBlocked: finding.markBlocked,
      }))
      const drawing = drawSheet(projectDraftSheet(scheme), {
        signSizes: new Map(),
        catalogLabel: 'Учебный каталог',
        revisionLabel: 'Учебная версия',
      })
      const bytes = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(JSON.stringify(drawing)),
      )
      const drawingSha256 = [...new Uint8Array(bytes)]
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('')
      expect({ findings, drawingSha256 }).toMatchSnapshot()
    })
  }
})
