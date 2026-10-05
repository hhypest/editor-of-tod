import { describe, expect, it } from 'vitest'
import { createUnlinkedScheme } from '../create-scheme'
import { applySchemeDetails, createSchemeDetailsDraft } from '../edit-details'
import { newSignDraft, savePlacement } from '../edit-placements'
import { exportSchemeJson, importSchemeJson } from '../import'
import { findingFingerprint, markState, setMark, unmarkedChecks } from '../review-marks'
import { reviewScheme as domainReviewScheme } from '../review-scheme'
import { pinSignImages } from '../sign-images'
import { rebuildTemplatePlacements } from '../template-placements'
import { PROTOTYPE_RULES, REGULATION_PARAMETERS } from '../normative-parameters'

const pddRules: typeof PROTOTYPE_RULES = {
  ...PROTOTYPE_RULES,
  pddDocument: { id: 1, label: 'ПДД-2030-01-01', sha256: 'a'.repeat(64) },
}
const reviewScheme = (scheme: Parameters<typeof domainReviewScheme>[0], rules = pddRules) =>
  domainReviewScheme(scheme, rules)

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
    location: 'out',
    approachSpeedKmh: '90',
    yellowTemporarySigns: false,
    workConditions: {
      kind: 'short',
      durationHours: 5,
      daylight: 'day',
      regulatorsPresent: true,
      sectionMetres: null,
    },
  })
  scheme.parameters.regulation = { ...scheme.parameters.regulation, mode: 'two', hourly: '300' }
  const post = newSignDraft()
  if (post.kind !== 'sign-post') throw new Error('Expected sign post')
  post.signCodes = '1.25'
  const withPost = savePlacement(scheme, post)
  // Два регулировщика на листе по раскладке шаблона: без них выпуск заблокирован.
  const regulators = rebuildTemplatePlacements(scheme)
    .scheme.placements.filter((item) => item.kind === 'element' && item.elementKind === 'reg')
    .map((item, index) => ({
      ...item,
      id: withPost.nextPlacementId + index,
      generatedByTemplate: false,
      templateSlot: undefined,
    }))
  const withRegulators = {
    ...withPost,
    placements: [...withPost.placements, ...regulators],
    nextPlacementId: withPost.nextPlacementId + regulators.length,
  }
  // Знаки закреплены: без этого пункт «Знаки на стойках» отметить нельзя.
  return pinSignImages(withRegulators, { id: 1, documentCode: 'ГОСТ TEST', edition: '2024' }, [
    { code: '1.25', revision: 1 },
    { code: '3.20', revision: 1 },
  ])
}

const now = '2026-09-30T10:00:00.000Z'

describe('manual review marks', () => {
  it.each(REGULATION_PARAMETERS)(
    'invalidates the traffic mark when %s needs reconfirmation',
    (id) => {
      const rules = {
        ...PROTOTYPE_RULES,
        confirmed: Object.fromEntries(REGULATION_PARAMETERS.map((parameter) => [parameter, true])),
      }
      const scheme = setMark(project(), reviewScheme(project(), rules), 'b34-traffic', true, now)
      const amended = { ...rules, confirmed: { ...rules.confirmed, [id]: false } }
      const findings = reviewScheme(scheme, amended)
      expect(
        markState(
          scheme,
          findings.find((finding) => finding.id === 'b34-traffic')!,
        ).status,
      ).toBe('stale')
      expect(unmarkedChecks(scheme, findings).map((finding) => finding.id)).toContain('b34-traffic')
    },
  )

  it('blocks incompatible imported conditions and invalidates marks when a bound changes', () => {
    let scheme = project()
    scheme = setMark(scheme, reviewScheme(scheme), 'b34-traffic', true, now)
    const rules = { ...PROTOTYPE_RULES, signsHourly: 240 }
    const changed = reviewScheme(scheme, rules).find((item) => item.id === 'b34-traffic')!
    expect(markState(scheme, changed).status).toBe('stale')
    for (const variant of ['auto', 'taper', 'visibility', 'long', 'intensity'] as const) {
      const imported = structuredClone(scheme)
      if (variant === 'auto') imported.parameters.regulation.mode = 'auto'
      if (variant === 'taper') {
        imported.parameters.regulation.mode = 'signs'
        imported.parameters.regulation.hourly = '180'
      }
      if (variant === 'visibility') {
        imported.parameters.regulation.mode = 'one'
        imported.parameters.regulation.straight = false
      }
      if (variant === 'long') imported.parameters.workZones.b34!.workMetres = 46
      if (variant === 'intensity') {
        imported.parameters.regulation.hourly = '501'
        imported.parameters.regulation.mode = 'one'
      }
      const findings = reviewScheme(imported)
      const finding = findings.find((item) => item.id === 'b34-traffic')!
      expect(markState(imported, finding).status).toBe('blocked')
      expect(() => setMark(imported, findings, finding.id, true, now)).toThrow('не соответствуют')
    }
  })
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
    // Новая стойка меняет расстановку, знаки и предметные проверки ПДД, включая скорость.
    const post = newSignDraft()
    if (post.kind !== 'sign-post') throw new Error('Expected sign post')
    post.signCodes = '3.20'
    const edited = savePlacement(scheme, post)
    const stale = unmarkedChecks(edited, reviewScheme(edited)).map((finding) => finding.id)
    expect(stale.sort()).toEqual([
      'pdd-crossing',
      'pdd-regulator',
      'pdd-speed',
      'pdd-temporary',
      'signs',
      'template',
    ])
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
    ).toEqual(stale.sort())
  })

  it('does not accept a sign check until the PNG revisions are pinned', () => {
    const unpinned = { ...project(), signImages: { catalog: null, revisions: {} } }
    const signs = reviewScheme(unpinned).find((finding) => finding.id === 'signs')!
    expect(markState(unpinned, signs).status).toBe('blocked')
    expect(() => setMark(unpinned, reviewScheme(unpinned), 'signs', true, now)).toThrow(
      'Закрепить редакции PNG',
    )
    expect(unmarkedChecks(unpinned, reviewScheme(unpinned)).map((f) => f.id)).toContain('signs')
  })

  it('invalidates the layout check when any template input or normative value changes', () => {
    let scheme = project()
    scheme = setMark(scheme, reviewScheme(scheme), 'template', true, now)
    const template = (value: typeof scheme, rules = PROTOTYPE_RULES) =>
      markState(
        value,
        reviewScheme(value, rules).find((finding) => finding.id === 'template')!,
      )
    expect(template(scheme).status).toBe('marked')
    const inside = {
      ...scheme,
      parameters: { ...scheme.parameters, location: 'in' as const },
    }
    expect(template(inside).status).toBe('stale')
    expect(template(scheme, { ...PROTOTYPE_RULES, speedStepKmh: 10 }).status).toBe('stale')
    // Название участка — подпись листа, раскладку не меняет.
    const renamed = { ...scheme, parameters: { ...scheme.parameters, locationText: 'Другое' } }
    expect(template(renamed).status).toBe('marked')
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
