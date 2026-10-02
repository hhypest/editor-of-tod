import legacy from '../../../tests/fixtures/manual-v1.json?raw'
import { describe, expect, it } from 'vitest'
import { importSchemeJson, exportSchemeJson } from '../import'
import { pu66StatusFinding, type Pu66Status } from '../pu66-lifecycle'
import { markState, setMark, unmarkedChecks } from '../review-marks'
import { reviewScheme } from '../review-scheme'

const project = () => importSchemeJson(legacy).scheme
const status: Pu66Status = {
  referenceId: 'TEST-001',
  excluded: true,
  successorKey: 'TEST-002',
  event: {
    id: 1,
    action: 'exclude',
    date: '2026-10-02',
    actor: 'Учебный составитель',
    reason: 'reassigned',
    comment: 'Учебное основание',
    successorKey: 'TEST-002',
    cardRevision: 1,
    recordedAt: '2026-10-02T10:00:00.000Z',
  },
}

describe('excluded PU-66 in the project checklist', () => {
  it('requires acknowledgment, preserves it through JSON and invalidates it after another exclusion', () => {
    const findings = [...reviewScheme(project()), ...pu66StatusFinding(status)]
    expect(unmarkedChecks(project(), findings).map((item) => item.id)).toContain('pu66-status')
    const marked = setMark(project(), findings, 'pu66-status', true)
    const reopened = importSchemeJson(exportSchemeJson(marked)).scheme
    expect(markState(reopened, pu66StatusFinding(status)[0]!).status).toBe('marked')
    expect(reopened.crossing).toEqual(project().crossing)
    expect(
      markState(reopened, pu66StatusFinding({ ...status, event: { ...status.event!, id: 3 } })[0]!)
        .status,
    ).toBe('stale')
    expect(pu66StatusFinding({ ...status, excluded: false })).toEqual([])
  })
  it('blocks acknowledgment when the local status cannot be checked', () => {
    const finding = pu66StatusFinding(null, true)[0]!
    expect(markState(project(), finding).status).toBe('blocked')
    expect(() => setMark(project(), [finding], finding.id, true)).toThrow('недоступен')
    expect(pu66StatusFinding(null)).toEqual([])
  })
})
