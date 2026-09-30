import { describe, expect, it } from 'vitest'
import { createUnlinkedScheme } from '../create-scheme'
import { figureDimensions } from '../figure-dimensions'
import { importSchemeJson } from '../import'
import { PROTOTYPE_RULES } from '../normative-parameters'
import { reviewScheme } from '../review-scheme'
import legacyB34 from '../../../tests/fixtures/legacy-b34-manual.json?raw'

function project(frontMetres: string, taperMetres: string, bufferMetres: string) {
  return createUnlinkedScheme({
    referenceId: 'TEST-FIGURE',
    locationText: 'Учебный участок',
    directionLeft: 'А',
    directionRight: 'Б',
    frontMetres,
    taperMetres,
    bufferMetres,
    speedStagesKmh: ['70', '50', '40'],
    yellowTemporarySigns: false,
  })
}

describe('dimension chains read from ODM figures B.33/B.34', () => {
  it('includes the exit taper only on B.33, including at the project boundary of 30 m', () => {
    const dimensions = figureDimensions(project('30', '5', '15'))
    expect(dimensions.map(({ part, figureLabel }) => [part, figureLabel])).toEqual([
      ['entry', '5–10 м'],
      ['buffer', '15 м'],
      ['front', 'min 30 м'],
      ['exit', '5–10 м'],
    ])
    expect(dimensions.every((part) => part.agreesWithFigure)).toBe(true)
    expect(dimensions[0]?.endX).toBe(dimensions[1]?.startX)
    expect(dimensions[1]?.endX).toBe(dimensions[2]?.startX)
    expect(dimensions[2]?.endX).toBe(dimensions[3]?.startX)
    expect(dimensions[3]?.endX).toBeGreaterThan(dimensions[3]?.startX ?? 0)
    expect(figureDimensions(project('50', '10', '15')).every((part) => part.agreesWithFigure)).toBe(
      true,
    )
  })

  it('uses the short-front chain and reports changed values without changing the project', () => {
    const scheme = project('29.9', '8', '12')
    const original = structuredClone(scheme)
    const dimensions = figureDimensions(scheme)
    expect(
      dimensions.map(({ part, figureLabel, agreesWithFigure }) => [
        part,
        figureLabel,
        agreesWithFigure,
      ]),
    ).toEqual([
      ['entry', '10 м', false],
      ['buffer', '10 м', false],
      ['front', 'max 30 м*', true],
    ])
    expect(scheme).toEqual(original)
    expect(figureDimensions(project('18', '10', '10')).every((part) => part.agreesWithFigure)).toBe(
      true,
    )
  })

  it('compares the B.34 taper with ODM 4.1.8.3 when priority signs 2.6/2.7 are chosen', () => {
    const withSigns = (taper: string) => {
      const scheme = project('21.5', taper, '10')
      return {
        ...scheme,
        parameters: {
          ...scheme.parameters,
          regulation: { ...scheme.parameters.regulation, mode: 'signs' as const },
        },
      }
    }
    const [entry] = figureDimensions(withSigns('15'))
    expect(entry).toMatchObject({ figureLabel: '15 м', agreesWithFigure: true })
    expect(entry?.basis).toContain('4.1.8.3')
    expect(figureDimensions(withSigns('10'))[0]?.agreesWithFigure).toBe(false)
    // Подтверждённое значение отгона заменяет значение прототипа.
    const rules = { ...PROTOTYPE_RULES, signsTaperMetres: 20 }
    expect(figureDimensions(withSigns('20'), rules)[0]).toMatchObject({
      figureLabel: '20 м',
      agreesWithFigure: true,
    })
    // Без знаков приоритета отвод по-прежнему сравнивается с рисунком.
    expect(figureDimensions(project('21.5', '15', '10'))[0]).toMatchObject({
      figureLabel: '10 м',
      agreesWithFigure: false,
    })
    expect(reviewScheme(withSigns('15')).some((f) => f.id === 'figure-dimensions')).toBe(false)
  })

  it('never silently revises an imported B.34 drawing to the new template dimensions', () => {
    const scheme = importSchemeJson(legacyB34).scheme
    const before = structuredClone(scheme)
    const dimensions = figureDimensions(scheme)
    expect(dimensions.map((part) => part.enteredMetres)).toEqual([
      scheme.parameters.workZones.b34?.taperMetres,
      scheme.parameters.workZones.b34?.bufferMetres,
      scheme.parameters.workZones.b34?.workMetres,
    ])
    expect(scheme).toEqual(before)
  })
})
