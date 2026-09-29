import { describe, expect, it } from 'vitest'
import { createNewScheme } from '../create-scheme'
import { applySchemeDetails, createSchemeDetailsDraft } from '../edit-details'
import { newSignDraft, savePlacement } from '../edit-placements'
import { linkPu66Card } from '../link-pu66'
import { reviewScheme } from '../review-scheme'
import legacyB34 from '../../../tests/fixtures/legacy-b34-manual.json?raw'
import legacyNewFields from '../../../tests/fixtures/legacy-v1-new-fields.json?raw'
import { importSchemeJson } from '../import'
import detailsEditor from '../../components/SchemeDetailsEditor.vue?raw'

function newProject(frontMetres = '18') {
  return createNewScheme(
    {
      referenceId: 'TEST-CROSSING',
      locationText: '',
      directionLeft: '',
      directionRight: '',
      frontMetres,
      taperMetres: '8',
      bufferMetres: '12',
      speedStagesKmh: ['70', '50', '40'],
      yellowTemporarySigns: false,
    },
    { id: '55740b36-080a-4cbe-9476-e71ffb1ab47f', now: '2026-09-26T12:00:00.000Z' },
  )
}

describe('live draft review', () => {
  it('reports empty fields separately from unresolved manual checks and updates after edits', () => {
    const initial = newProject()
    const initialFindings = reviewScheme(initial)
    expect(
      initialFindings.filter((finding) => finding.kind === 'fill').map((finding) => finding.id),
    ).toEqual(['place', 'developer', 'work', 'responsible', 'approver', 'agreement', 'placements'])
    expect(
      initialFindings.filter((finding) => finding.kind === 'verify').map((finding) => finding.id),
    ).toEqual(['crossing', 'template', 'figure-dimensions', 'b34-traffic'])

    const draft = createSchemeDetailsDraft(initial)
    draft.parameters.locationText = 'Учебный участок'
    draft.parameters.directions.left = 'А'
    draft.parameters.directions.right = 'Б'
    draft.titleBlock.developer.organization = 'Учебная организация'
    const edited = applySchemeDetails(initial, draft)
    expect(reviewScheme(edited).some((finding) => finding.id === 'place')).toBe(false)
    expect(reviewScheme(edited).find((finding) => finding.id === 'developer')?.detail).toContain(
      'ФИО, дата',
    )
    expect(reviewScheme(initial).some((finding) => finding.id === 'place')).toBe(true)
  })

  it('points each fill finding at the first empty form field', () => {
    const initial = newProject()
    const field = (scheme: typeof initial, id: string) =>
      reviewScheme(scheme).find((finding) => finding.id === id)?.field
    expect(field(initial, 'place')).toBe('parameters.locationText')
    expect(field(initial, 'responsible')).toBe('titleBlock.responsible.0')
    const draft = createSchemeDetailsDraft(initial)
    draft.parameters.locationText = 'Учебный участок'
    draft.titleBlock.developer.organization = 'Учебная организация'
    const edited = applySchemeDetails(initial, draft)
    expect(field(edited, 'place')).toBe('parameters.directions.left')
    expect(field(edited, 'developer')).toBe('titleBlock.developer.name')
    const post = newSignDraft()
    if (post.kind !== 'sign-post') throw new Error('Expected sign draft')
    post.signCodes = '1.25'
    post.distanceLabel = '{d150}'
    expect(field(savePlacement(initial, post), 'distance-d150')).toBe(
      'parameters.signDistancesMetres.d150',
    )
  })

  it('has a form input for every field a finding can point at', () => {
    const post = newSignDraft()
    if (post.kind !== 'sign-post') throw new Error('Expected sign draft')
    post.signCodes = '1.25'
    post.distanceLabel = '{d300} {d250} {d150} {d50} {n100} {n50}'
    const paths = new Set<string>()
    const empty = savePlacement(newProject(), post)
    for (const finding of reviewScheme(empty)) if (finding.field) paths.add(finding.field)
    // Заполняем поля по одному, чтобы каждое по очереди стало «первым незаполненным».
    let draft = createSchemeDetailsDraft(empty)
    for (let step = 0; step < 20; step++) {
      const findings = reviewScheme(applySchemeDetails(empty, draft)).filter((f) => f.field)
      if (!findings.length) break
      for (const finding of findings) {
        paths.add(finding.field!)
        const keys = finding.field!.split('.')
        let target: Record<string, unknown> = draft as unknown as Record<string, unknown>
        for (const key of keys.slice(0, -1)) target = target[key] as Record<string, unknown>
        target[keys.at(-1)!] = keys[1] === 'signDistancesMetres' ? '100' : 'Учебное значение'
      }
      draft = { ...draft }
    }
    expect(paths.size).toBeGreaterThan(15)
    for (const path of paths) expect(detailsEditor).toContain(`data-field="${path}"`)
  })

  it('flags only missing distances referenced by sign posts and removes them when entered', () => {
    const draft = newSignDraft()
    if (draft.kind !== 'sign-post') throw new Error('Expected sign draft')
    draft.signCodes = '1.25'
    draft.distanceLabel = '{d300} / {d50}'
    const withPost = savePlacement(newProject(), draft)
    const initialIds = reviewScheme(withPost).map((finding) => finding.id)
    expect(initialIds).toContain('distance-d300')
    expect(initialIds).toContain('distance-d50')
    expect(initialIds).not.toContain('distance-d250')
    expect(initialIds).not.toContain('placements')
    expect(initialIds).toContain('signs')

    const details = createSchemeDetailsDraft(withPost)
    details.parameters.signDistancesMetres.d300 = '300'
    const afterEdit = reviewScheme(applySchemeDetails(withPost, details)).map(
      (finding) => finding.id,
    )
    expect(afterEdit).not.toContain('distance-d300')
    expect(afterEdit).toContain('distance-d50')
  })

  it('keeps PU-66 and the 30 m boundary on the manual checklist after linking', () => {
    const project = newProject('30')
    expect(reviewScheme(project).find((finding) => finding.id === 'boundary-30')?.kind).toBe(
      'verify',
    )
    const linked = linkPu66Card(project, {
      referenceId: 'TEST-PU66',
      location: 'Учебный километр',
      axisLabel: 'Учебная ось',
      roadName: 'Условная дорога',
      crossingWidthMetres: 8,
      revision: 2,
      updatedAt: '2026-09-26T12:00:00.000Z',
    })
    const findings = reviewScheme(linked)
    expect(findings.find((finding) => finding.id === 'crossing')?.detail).toContain(
      'редакция ПУ-66 № 2',
    )
    expect(findings.find((finding) => finding.id === 'template')?.kind).toBe('verify')
    expect(findings.some((finding) => finding.id === 'boundary-30')).toBe(true)
  })

  it('removes the figure size difference after correction, but keeps manual applicability checks', () => {
    const initial = newProject()
    const draft = createSchemeDetailsDraft(initial)
    draft.parameters.workZones.b34!.taperMetres = '10'
    draft.parameters.workZones.b34!.bufferMetres = '10'
    const findings = reviewScheme(applySchemeDetails(initial, draft))
    expect(findings.some((finding) => finding.id === 'figure-dimensions')).toBe(false)
    expect(findings.some((finding) => finding.id === 'b34-traffic')).toBe(true)
    expect(findings.some((finding) => finding.id === 'template')).toBe(true)

    const longFront = reviewScheme(newProject('30'))
    expect(longFront.find((finding) => finding.id === 'figure-dimensions')?.detail).toContain(
      'участок перед фронтом 12 м (на рисунке 15 м)',
    )
    expect(longFront.some((finding) => finding.id === 'b34-traffic')).toBe(false)
  })

  it('treats an imported B.34 with exactly 30 m as a variant conflict, not as a false figure-size error', () => {
    const scheme = importSchemeJson(legacyB34).scheme
    const atBoundary = {
      ...scheme,
      parameters: {
        ...scheme.parameters,
        workZones: {
          ...scheme.parameters.workZones,
          b34: { ...scheme.parameters.workZones.b34!, workMetres: 30 },
        },
      },
    }
    const findings = reviewScheme(atBoundary)
    expect(findings.some((finding) => finding.id === 'variant-front')).toBe(true)
    expect(findings.some((finding) => finding.id === 'figure-dimensions')).toBe(false)
  })

  it('flags a legacy project whose visibility flag was copied without inversion', () => {
    const newer = JSON.parse(legacyNewFields) as { params: { reg: { vis: boolean } } }
    const imported = importSchemeJson(legacyNewFields).scheme
    expect(reviewScheme(imported).some((finding) => finding.id === 'legacy-visibility')).toBe(false)
    // Так выглядел проект, импортированный до исправления: флаг скопирован без перевода смысла.
    const copied = {
      ...imported,
      parameters: {
        ...imported.parameters,
        regulation: { ...imported.parameters.regulation, vis: newer.params.reg.vis },
      },
    }
    const finding = reviewScheme(copied).find((item) => item.id === 'legacy-visibility')
    expect(finding).toMatchObject({ kind: 'verify', target: '#details-title' })
    expect(finding?.detail).toContain('обеспеченная')
  })
})
