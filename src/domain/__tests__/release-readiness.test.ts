import { describe, expect, it } from 'vitest'
import { importSchemeJson } from '../import'
import { releaseProblems } from '../release-readiness'
import type { Scheme } from '../model'
import { projectDraftSheet } from '../draft-sheet'
import { drawSheet } from '../sheet-drawing'
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
      regulation: { ...scheme.parameters.regulation, mode: 'two' as const },
      workConditions: {
        kind: 'short' as const,
        durationHours: 8,
        daylight: 'day' as const,
        regulatorsPresent: true,
        sectionMetres: null,
      },
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

  it('does not release a sheet whose notes would print a placeholder instead of work conditions', () => {
    const base = example()
    const withConditions = (conditions: Partial<Scheme['parameters']['workConditions']>) => ({
      ...base,
      parameters: {
        ...base.parameters,
        workConditions: { ...base.parameters.workConditions, ...conditions },
      },
    })
    const texts = (scheme: Scheme) =>
      drawSheet(projectDraftSheet(scheme), {
        signSizes: new Map(),
        catalogLabel: '',
        revisionLabel: '',
        release: true,
      })
        .nodes.flatMap((node) => (node.t === 'text' ? [node.text] : []))
        .join(' ')

    // Неизвестное время суток раньше проходило выпуск и печаталось как «время суток уточнить».
    const unknownDaylight = withConditions({ daylight: 'unknown' })
    expect(texts(unknownDaylight)).toContain('уточнить')
    expect(releaseProblems(unknownDaylight)).toEqual([
      'Укажите на этапе 2, выполняются ли работы только в светлое время суток.',
    ])
    expect(releaseProblems(withConditions({ kind: 'unknown' })).join(' ')).toContain(
      'краткосрочные работы или долгосрочные',
    )
    expect(releaseProblems(withConditions({ durationHours: null })).join(' ')).toContain(
      'продолжительность работ',
    )
    const unconfirmed = withConditions({ regulatorsPresent: false })
    expect(texts(unconfirmed)).toContain('требуется проверка')
    expect(releaseProblems(unconfirmed).join(' ')).toContain('присутствие регулировщиков')
    const signs = {
      ...unconfirmed,
      parameters: {
        ...unconfirmed.parameters,
        regulation: { ...unconfirmed.parameters.regulation, mode: 'signs' as const },
      },
    }
    expect(releaseProblems(signs)).toEqual([])
    const auto = {
      ...base,
      parameters: {
        ...base.parameters,
        regulation: { ...base.parameters.regulation, mode: 'auto' as const },
      },
    }
    expect(releaseProblems(auto).join(' ')).toContain('способ пропуска транспорта')

    for (const scheme of [base, signs]) {
      expect(releaseProblems(scheme)).toEqual([])
      expect(texts(scheme)).not.toMatch(/уточнить|требуется проверка/)
    }
  })

  it('finds an unfilled marker in any text of the sheet, not only in post distances', () => {
    const scheme = example()
    const nodes = [
      { t: 'text' as const, x: 0, y: 0, text: 'Участок {d150} м до переезда', size: 12 },
      { t: 'text' as const, x: 0, y: 0, text: 'Готовая надпись', size: 12 },
    ]
    expect(releaseProblems(scheme, nodes)).toEqual([
      'В надписях листа осталась незаполненная подстановка {d150}. Замените её значением.',
    ])
    // Подстановка стойки сообщается один раз — с номером стойки.
    scheme.parameters.signDistancesMetres.d50 = null
    expect(
      releaseProblems(scheme, [{ t: 'text', x: 0, y: 0, text: '{d50}', size: 12 }]),
    ).toHaveLength(1)
  })
})
