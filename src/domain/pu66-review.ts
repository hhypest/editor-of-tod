import { z } from 'zod'

export const pu66VerificationWriteSchema = z.strictObject({
  expectedRevision: z.number().int().positive(),
  verifiedAt: z.iso.date(),
  verifiedBy: z.string().trim().min(1).max(240),
})

export type Pu66VerificationWrite = z.infer<typeof pu66VerificationWriteSchema>
export type Pu66Verification = {
  cardRevision: number
  verifiedAt: string
  verifiedBy: string
  recordedAt: string
}

/** The editor and its API run on the same workstation. */
export function localCalendarDate(now: Date): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

/** Annual local workflow deadline; a workbook import is never a completed review. */
export function annualPu66ReviewStatus(
  verifiedAt: string | null,
  asOf: string,
): { kind: 'unverified' | 'current' | 'due' | 'overdue'; nextDue: string | null } {
  if (!verifiedAt) return { kind: 'unverified', nextDue: null }
  const nextDue = `${Number(verifiedAt.slice(0, 4)) + 1}-01-30`
  return {
    kind: asOf < nextDue ? 'current' : asOf === nextDue ? 'due' : 'overdue',
    nextDue,
  }
}
