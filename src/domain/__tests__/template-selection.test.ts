import { describe, expect, it } from 'vitest'
import { selectTemplateByWorkFront } from '../registry'
import {
  PROTOTYPE_RULES,
  parameterDefinition,
  rulesFrom,
  type ParameterState,
} from '../normative-parameters'

describe('work front length selection policy', () => {
  it('uses B.34 up to 30 m inclusive and B.33 above 30 m', () => {
    expect(selectTemplateByWorkFront(29.99)).toEqual({ code: 'b34' })
    expect(selectTemplateByWorkFront(30)).toEqual({ code: 'b34' })
    expect(selectTemplateByWorkFront(30.01)).toEqual({ code: 'b33' })
    expect(selectTemplateByWorkFront(45)).toEqual({ code: 'b33' })
  })

  it('takes the threshold and the front limit from project decisions, not constants', () => {
    expect(PROTOTYPE_RULES.b34MaxFrontMetres).toBe(30)
    expect(PROTOTYPE_RULES.frontLimitMetres).toBe(45)
    for (const id of ['project-b34-max-front', 'project-front-limit']) {
      expect(parameterDefinition(id)?.source.kind).toBe('decision')
    }
    // Основание — рисунки ОДМ (ответ составителя 12.10.2026); граница 30 м — решение проекта.
    expect(PROTOTYPE_RULES.sources['project-b34-max-front']).toBe(
      'ОДМ 218.6.019-2016, рис. Б.33 и Б.34; граница относится к Б.34 по решению проекта',
    )
    expect(PROTOTYPE_RULES.sources['project-front-limit']).toBe(
      'ОДМ 218.6.019-2016, рис. Б.33 и Б.34',
    )
    const changed = { ...PROTOTYPE_RULES, b34MaxFrontMetres: 25 }
    expect(selectTemplateByWorkFront(25, changed)).toEqual({ code: 'b34' })
    expect(selectTemplateByWorkFront(26, changed)).toEqual({ code: 'b33' })
  })

  it('reads confirmed values of the decision parameters with their basis', () => {
    const decision = (id: string, value: number, index: number): ParameterState => ({
      id,
      status: { kind: 'confirmed' },
      document: null,
      quote: null,
      suggestion: null,
      amendments: [],
      confirmation: {
        id: index,
        parameterId: id,
        documentId: null,
        documentLabel: '',
        clause: '',
        page: null,
        quote: '',
        fragment: '',
        value,
        confirmedBy: 'Учебный составитель',
        confirmedAt: '2030-01-01T00:00:00.000Z',
        note: 'Учебное основание: протокол совещания № 1',
      },
    })
    const rules = rulesFrom([
      decision('project-b34-max-front', 25, 1),
      decision('project-front-limit', 60, 2),
    ])
    expect(rules.b34MaxFrontMetres).toBe(25)
    expect(rules.frontLimitMetres).toBe(60)
    expect(rules.confirmed['project-b34-max-front']).toBe(true)
    expect(selectTemplateByWorkFront(30, rules)).toEqual({ code: 'b33' })
  })

  it('rejects missing and non-finite lengths', () => {
    for (const value of [0, -1, NaN, Infinity]) {
      expect(() => selectTemplateByWorkFront(value)).toThrow(RangeError)
    }
  })
})
