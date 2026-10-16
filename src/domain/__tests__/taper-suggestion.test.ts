import { describe, expect, it } from 'vitest'
import { PROTOTYPE_RULES } from '../normative-parameters'
import { taperSuggestion } from '../taper-suggestion'

const rules = PROTOTYPE_RULES
const suggest = (
  mode: 'auto' | 'signs' | 'one' | 'two',
  taperMetres: number | null,
  template: 'b33' | 'b34' = 'b34',
) => taperSuggestion({ template, mode, taperMetres }, rules)

describe('taper suggestion when the B.34 regulation mode changes', () => {
  it('offers the table I.1 value for priority signs unless it is already entered', () => {
    expect(rules.signsTaperMetres).toBe(15)
    const offer = suggest('signs', 10)
    expect(offer).toMatchObject({ metres: 15, parameterId: 'odm-signs-taper' })
    expect(offer!.text).toBe(
      `Для знаков приоритета 2.6/2.7 отвод — 15 м (${rules.sources['odm-signs-taper']}); сейчас 10 м.`,
    )
    expect(suggest('signs', null)!.text).toContain('сейчас он не введён')
    expect(suggest('signs', 15)).toBeNull()
  })

  it('offers the figure B.34 value for regulators only when the signs value was left over', () => {
    expect(rules.b34TaperMetres).toBe(10)
    for (const mode of ['one', 'two'] as const) {
      expect(suggest(mode, 15)).toMatchObject({ metres: 10, parameterId: 'odm-b34-taper' })
      // Своё значение при регулировщиках — решение составителя, его не трогают.
      expect(suggest(mode, 12)).toBeNull()
      expect(suggest(mode, 10)).toBeNull()
      expect(suggest(mode, null)).toBeNull()
    }
    expect(suggest('one', 15)!.text).toContain('рисунке Б.34 отвод 10 м')
  })

  it('stays silent without a decided mode, for B.33 and when both values coincide', () => {
    expect(suggest('auto', 7)).toBeNull()
    expect(suggest('signs', 7, 'b33')).toBeNull()
    expect(
      taperSuggestion(
        { template: 'b34', mode: 'two', taperMetres: 15 },
        { ...rules, b34TaperMetres: 15 },
      ),
    ).toBeNull()
  })

  it('follows confirmed parameter values, not constants', () => {
    const confirmed = { ...rules, signsTaperMetres: 20, b34TaperMetres: 8 }
    expect(
      taperSuggestion({ template: 'b34', mode: 'signs', taperMetres: 15 }, confirmed)?.metres,
    ).toBe(20)
    expect(
      taperSuggestion({ template: 'b34', mode: 'one', taperMetres: 20 }, confirmed)?.metres,
    ).toBe(8)
    expect(taperSuggestion({ template: 'b34', mode: 'one', taperMetres: 15 }, confirmed)).toBeNull()
  })
})
