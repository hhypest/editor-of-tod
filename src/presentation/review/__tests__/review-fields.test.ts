import { describe, expect, it } from 'vitest'
import { createUnlinkedScheme } from '../../../domain/create-scheme'
import { applySchemeDetails, createSchemeDetailsDraft } from '../../../domain/edit-details'
import { newSignDraft, savePlacement } from '../../../domain/edit-placements'
import { reviewScheme, type ReviewFinding } from '../../../domain/review-scheme'
import detailsEditor from '../../../components/SchemeDetailsEditor.vue?raw'
import { mapReviewTarget } from '../map-review-target'

function withTarget(finding: ReviewFinding) {
  return { ...finding, field: mapReviewTarget(finding).field }
}

function newProject(frontMetres = '18') {
  return createUnlinkedScheme(
    {
      referenceId: 'TEST-CROSSING',
      locationText: '',
      directionLeft: '',
      directionRight: '',
      frontMetres,
      taperMetres: '8',
      bufferMetres: '12',
      speedStagesKmh: ['70', '50', '40'],
      location: 'out',
      approachSpeedKmh: '90',
      yellowTemporarySigns: false,
    },
    { id: '55740b36-080a-4cbe-9476-e71ffb1ab47f', now: '2026-09-26T12:00:00.000Z' },
  )
}

/** Проект с очищенными расстояниями: новые проекты получают их по нормативным параметрам. */
function withoutDistances(scheme: ReturnType<typeof newProject>) {
  const draft = createSchemeDetailsDraft(scheme)
  for (const key of ['d300', 'd250', 'd150', 'd50', 'n100', 'n50'] as const)
    draft.parameters.signDistancesMetres[key] = ''
  return applySchemeDetails(scheme, draft)
}

describe('review paths have matching editor inputs', () => {
  it('has a form input for every field a finding can point at', () => {
    const post = newSignDraft()
    if (post.kind !== 'sign-post') throw new Error('Expected sign draft')
    post.signCodes = '1.25'
    post.distanceLabel = '{d300} {d250} {d150} {d50} {n100} {n50}'
    const paths = new Set<string>()
    const empty = savePlacement(withoutDistances(newProject()), post)
    for (const finding of reviewScheme(empty).map(withTarget))
      if (finding.kind === 'fill' && finding.field) paths.add(finding.field)
    // Заполняем поля по одному, чтобы каждое по очереди стало «первым незаполненным».
    let draft = createSchemeDetailsDraft(empty)
    for (let step = 0; step < 20; step++) {
      const findings = reviewScheme(applySchemeDetails(empty, draft))
        .map(withTarget)
        .filter((f) => f.kind === 'fill' && f.field)
      if (!findings.length) break
      for (const finding of findings) {
        paths.add(finding.field!)
        const keys = finding.field!.split('.')
        let target: Record<string, unknown> = draft as unknown as Record<string, unknown>
        for (const key of keys.slice(0, -1)) target = target[key] as Record<string, unknown>
        target[keys.at(-1)!] =
          keys[1] === 'location'
            ? 'out'
            : keys[1] === 'signSize'
              ? 'II'
              : keys[1] === 'signDistancesMetres'
                ? '100'
                : keys.at(-1) === 'phone'
                  ? '+7 (900) 000-00-00'
                  : 'Учебное значение'
      }
      draft = { ...draft }
    }
    expect(paths.size).toBeGreaterThan(15)
    for (const path of paths) {
      // Поля ответственных строятся в цикле: `titleBlock.responsible.${index}.name`.
      // Расстояния — в цикле по полям местоположения: `parameters.signDistancesMetres.${field}`.
      const responsible = /^titleBlock\.responsible\.\d+\.(\w+)$/.exec(path)
      const distance = /^parameters\.signDistancesMetres\.(\w+)$/.exec(path)
      expect(detailsEditor).toContain(
        responsible
          ? `:data-field="\`titleBlock.responsible.\${index}.${responsible[1]}\`"`
          : distance
            ? `:data-field="\`parameters.signDistancesMetres.\${field}\`"`
            : `data-field="${path}"`,
      )
      if (distance) expect(detailsEditor).toContain(`distanceFields[draft.parameters.location]`)
    }
  })
})
