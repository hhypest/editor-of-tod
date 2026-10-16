import type { NormativeRules } from './normative-parameters'
import { decimalComma } from './number-format'
import type { RegulationMode } from './regulation-advice'

/**
 * Предложение длины отвода Б.34 при смене способа пропуска (П3, issue #104). Программа только
 * предлагает число рядом с полем: подставляет его составитель кнопкой, введённое значение
 * молча не заменяется.
 *
 * - Знаки 2.6/2.7: отвод по таблице И.1, примечанию 3 ГОСТ Р 58350 (`odm-signs-taper`); без него
 *   шаблон не собирается и пункт «Условия движения для Б.34» блокирует выпуск.
 * - Регулировщики: если в поле осталось значение для знаков, предлагается отвод рисунка Б.34
 *   (`odm-b34-taper`). Иное число при регулировщиках — решение составителя, оно не трогается.
 */
export type TaperSuggestion = {
  metres: number
  /** Почему предлагается это число, с источником — текст рядом с полем. */
  text: string
  parameterId: 'odm-signs-taper' | 'odm-b34-taper'
}

export function taperSuggestion(
  input: {
    template: 'b33' | 'b34'
    mode: RegulationMode | 'auto'
    /** Введённый отвод зоны Б.34; null — не введён или неразборчив. */
    taperMetres: number | null
  },
  rules: NormativeRules,
): TaperSuggestion | null {
  if (input.template !== 'b34') return null
  if (input.mode === 'signs' && input.taperMetres !== rules.signsTaperMetres)
    return {
      metres: rules.signsTaperMetres,
      text: `Для знаков приоритета 2.6/2.7 отвод — ${decimalComma(rules.signsTaperMetres)} м (${rules.sources['odm-signs-taper']}); сейчас ${
        input.taperMetres === null ? 'он не введён' : `${decimalComma(input.taperMetres)} м`
      }.`,
      parameterId: 'odm-signs-taper',
    }
  if (
    (input.mode === 'one' || input.mode === 'two') &&
    input.taperMetres === rules.signsTaperMetres &&
    rules.signsTaperMetres !== rules.b34TaperMetres
  )
    return {
      metres: rules.b34TaperMetres,
      text: `В поле остался отвод для знаков 2.6/2.7 — ${decimalComma(rules.signsTaperMetres)} м. При регулировщиках на рисунке Б.34 отвод ${decimalComma(rules.b34TaperMetres)} м (${rules.sources['odm-b34-taper']}); иное значение — решение составителя.`,
      parameterId: 'odm-b34-taper',
    }
  return null
}
