import type { Scheme } from './model'
import { roadAutomationCurrent } from './road-automation-state'
import { roadCalculationBasis } from './road-calculation-state'
export function roadNotesBasis(
  s: Pick<Scheme, 'roadLayout' | 'template'> & {
    parameters: Scheme['parameters']
  },
) {
  return roadCalculationBasis([s.roadLayout.nodes, s.parameters, s.template.code])
}
export function roadSheetNotes(s: Scheme): string[] {
  if (s.roadLayout.notes)
    return s.roadLayout.notes.text
      .split('\n')
      .map((text) => text.trim())
      .filter(Boolean)
  if (!s.roadLayout.nodes.length && !s.roadLayout.automation) return []
  const result = ['Копию схемы передать в УГИБДД.']
  if (s.roadLayout.nodes.some((node) => node.kind === 'junction' && node.roadKind === 'road'))
    result.push(
      'После примыканий повторяются знаки по принятому профилю проекта; состав и расстояния сверяются по ГОСТ Р 52289-2019, пп. 5.2.3, 5.4.21–5.4.22.',
    )
  if (roadAutomationCurrent(s) && s.roadLayout.nodes.some((node) => node.kind === 'terminal-tee'))
    result.push(
      'За конечным Т-перекрёстком прямого продолжения дороги нет. Стойки перенесены на обе ветви по согласованному решению проекта; ручные изменения сохраняются.',
    )
  return result
}
