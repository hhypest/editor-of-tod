import { describe, expect, it } from 'vitest'
import { createNewScheme } from '../create-scheme'
import { figureDimensions } from '../figure-dimensions'
import { importSchemeJson } from '../import'
import legacyB34 from '../../../tests/fixtures/legacy-b34-manual.json?raw'

function project(frontMetres: string, taperMetres: string, bufferMetres: string) {
  return createNewScheme({
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
