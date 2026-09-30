import { describe, expect, it } from 'vitest'
import { createUnlinkedScheme } from '../create-scheme'
import { applySchemeDetails, createSchemeDetailsDraft } from '../edit-details'
import { newSignDraft, savePlacement } from '../edit-placements'
import { exportSchemeJson, importSchemeJson } from '../import'
import { findingFingerprint, markState, setMark, unmarkedChecks } from '../review-marks'
import { reviewScheme } from '../review-scheme'

function project() {
  const scheme = createUnlinkedScheme({
    referenceId: 'TEST-MARKS',
    locationText: 'Учебный участок',
    directionLeft: 'А',
    directionRight: 'Б',
    frontMetres: '18',
    taperMetres: '10',
    bufferMetres: '10',
    speedStagesKmh: ['70', '50', '40'],
    yellowTemporarySigns: false,
  })
  const post = newSignDraft()
  if (post.kind !== 'sign-post') throw new Error('Expected sign post')
  post.signCodes = '1.25'
  return savePlacement(scheme, post)
}

const now = '2026-09-30T10:00:00.000Z'

describe('manual review marks', () => {
  it('marks every manual check and keeps marks in the saved project', () => {
    let scheme = project()
    const findings = reviewScheme(scheme)
    const checks = findings.filter((finding) => finding.kind === 'verify')
    expect(checks.map((finding) => finding.id)).toEqual(
      expect.arrayContaining(['crossing', 'template', 'signs']),
    )
    expect(unmarkedChecks(scheme, findings)).toHaveLength(checks.length)
    for (const check of checks) scheme = setMark(scheme, reviewScheme(scheme), check.id, true, now)
    expect(unmarkedChecks(scheme, reviewScheme(scheme))).toEqual([])
    expect(markState(scheme, checks[0]!)).toEqual({ status: 'marked', markedAt: now })
    const reopened = importSchemeJson(exportSchemeJson(scheme)).scheme
    expect(unmarkedChecks(reopened, reviewScheme(reopened))).toEqual([])
  })

  it('invalidates only the check whose data changed', () => {
    let scheme = project()
    for (const check of reviewScheme(scheme).filter((finding) => finding.kind === 'verify'))
      scheme = setMark(scheme, reviewScheme(scheme), check.id, true, now)
    // Новая стойка меняет данные пунктов «Вариант и расстановка» и «Знаки на стойках».
    const post = newSignDraft()
    if (post.kind !== 'sign-post') throw new Error('Expected sign post')
    post.signCodes = '3.20'
    const edited = savePlacement(scheme, post)
    const stale = unmarkedChecks(edited, reviewScheme(edited)).map((finding) => finding.id)
    expect(stale.sort()).toEqual(['signs', 'template'])
    const crossing = reviewScheme(edited).find((finding) => finding.id === 'crossing')!
    expect(markState(edited, crossing).status).toBe('marked')
    const template = reviewScheme(edited).find((finding) => finding.id === 'template')!
    expect(markState(edited, template)).toEqual({ status: 'stale', markedAt: now })
    // Реквизиты листа не влияют на отметки ручной проверки.
    const draft = createSchemeDetailsDraft(edited)
    draft.titleBlock.work.description = 'Учебные работы'
    const titled = applySchemeDetails(edited, draft)
    expect(
      unmarkedChecks(titled, reviewScheme(titled))
        .map((finding) => finding.id)
        .sort(),
    ).toEqual(['signs', 'template'])
  })

  it('unmarks a check and drops marks of checks that no longer exist', () => {
    let scheme = project()
    scheme = setMark(scheme, reviewScheme(scheme), 'signs', true, now)
    scheme = setMark(scheme, reviewScheme(scheme), 'crossing', true, now)
    scheme = setMark(scheme, reviewScheme(scheme), 'crossing', false, now)
    expect(Object.keys(scheme.reviewMarks)).toEqual(['signs'])
    const withoutPosts = { ...scheme, placements: [] }
    const cleaned = setMark(withoutPosts, reviewScheme(withoutPosts), 'template', true, now)
    expect(Object.keys(cleaned.reviewMarks)).toEqual(['template'])
    expect(() => setMark(scheme, reviewScheme(scheme), 'place', true, now)).toThrow(
      'Пункт ручной проверки не найден',
    )
    expect(findingFingerprint(reviewScheme(scheme)[0]!)).toMatch(/^[0-9a-f]{16}$/)
  })
})
