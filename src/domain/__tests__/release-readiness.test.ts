import { describe, expect, it } from 'vitest'
import { importSchemeJson } from '../import'
import { releaseProblems } from '../release-readiness'
import type { Scheme } from '../model'
import legacy from '../../../tests/fixtures/legacy-b34-manual.json?raw'

function example(): Scheme {
  const scheme = importSchemeJson(legacy).scheme
  return {
    ...scheme,
    parameters: {
      ...scheme.parameters,
      location: 'out' as const,
      signSize: 'II' as const,
      signDistancesMetres: { ...scheme.parameters.signDistancesMetres, d50: 50 },
    },
    placements: scheme.placements
      .filter((p) => p.kind === 'sign-post')
      .slice(0, 1)
      .map((p) => ({
        ...p,
        distanceLabel: '{d50}',
      })),
  }
}

describe('release integrity', () => {
  it('requires referenced distances and rejects unknown markers', () => {
    const scheme = example()
    expect(releaseProblems(scheme)).toEqual([])
    scheme.parameters.signDistancesMetres.d50 = null
    expect(releaseProblems(scheme).join(' ')).toContain('{d50}')
    const post = scheme.placements.find((p) => p.kind === 'sign-post')!
    post.distanceLabel = '{unknown} / {d50}'
    expect(releaseProblems(scheme).join(' ')).toContain('{unknown}, {d50}')
  })

  it('requires objects, location and type size in both locations', () => {
    const scheme = example()
    expect(releaseProblems({ ...scheme, placements: [] })).toContain('На листе нет объектов схемы.')
    for (const location of ['in', 'out', 'auto'] as const) {
      const problems = releaseProblems({
        ...scheme,
        parameters: { ...scheme.parameters, location, signSize: 'auto' },
      })
      expect(problems.join(' ')).toContain('типоразмер')
      expect(problems.some((p) => p.includes('населённом пункте'))).toBe(location === 'auto')
    }
  })

  it('allows blank paper requisites without ignoring integrity errors', () => {
    const scheme = example()
    scheme.titleBlock.developer.name = ''
    scheme.titleBlock.approver.name = ''
    scheme.titleBlock.agreement.name = ''
    expect(releaseProblems(scheme)).toEqual([])
  })
})
