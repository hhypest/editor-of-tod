import { describe, expect, it } from 'vitest'
import { annualPu66ReviewStatus, pu66VerificationWriteSchema } from '../pu66-review'

describe('annual PU-66 review record', () => {
  it('uses 30 January every year as the next review date', () => {
    expect(annualPu66ReviewStatus(null, '2026-01-30')).toEqual({
      kind: 'unverified',
      nextDue: null,
    })
    expect(annualPu66ReviewStatus('2026-01-30', '2027-01-29')).toEqual({
      kind: 'current',
      nextDue: '2027-01-30',
    })
    expect(annualPu66ReviewStatus('2026-01-30', '2027-01-30')).toEqual({
      kind: 'due',
      nextDue: '2027-01-30',
    })
    expect(annualPu66ReviewStatus('2026-01-30', '2027-01-31')).toEqual({
      kind: 'overdue',
      nextDue: '2027-01-30',
    })
    expect(annualPu66ReviewStatus('2027-01-30', '2027-01-30').kind).toBe('current')
  })

  it('requires an actual date and a named reviewing subdivision', () => {
    expect(
      pu66VerificationWriteSchema.safeParse({
        expectedRevision: 1,
        verifiedAt: '2026-01-30',
        verifiedBy: 'Линейное подразделение (учебное)',
      }).success,
    ).toBe(true)
    expect(
      pu66VerificationWriteSchema.safeParse({
        expectedRevision: 1,
        verifiedAt: '2026-01-30',
        verifiedBy: '  ',
      }).success,
    ).toBe(false)
  })
})
