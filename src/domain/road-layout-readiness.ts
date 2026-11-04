import { legacyRoadLayoutProblem } from './legacy-road-layout.ts'
import { roadValuesEqual } from './road-calculation-state'
import type { NormativeRules } from './normative-parameters'
import { roadAutomationCurrent } from './road-automation-state'
import type { Scheme } from './model'
import type { RoadLayout } from './road-layout.ts'
import { unsupportedLegacyRoadProblem } from './migrate-road-layout'

export const ROAD_LAYOUT_PROBLEM =
  'Данные примыканий сохранены. Полный план расстановки не применён или устарел. Подготовьте и примените полный план; сохранение проекта и черновик для сверки доступны.'

/** A v12 project must not bypass protection by having no legacy source. */
export function roadLayoutProblem(
  scheme: {
    source: { kind: string; originalJson?: string }
    roadLayout: RoadLayout
    parameters?: Scheme['parameters']
    template?: Scheme['template']
    placements?: Scheme['placements']
    roadObjectExclusions?: Scheme['roadObjectExclusions']
  },
  rules?: NormativeRules,
): string | null {
  const unsupported = unsupportedLegacyRoadProblem(scheme.source)
  if (unsupported) return unsupported
  if (roadAutomationCurrent(scheme)) {
    if (
      rules &&
      !roadValuesEqual(scheme.roadLayout.automation!.profile, Object.values(rules.parameterBasis))
    )
      return 'Параметры автоматики изменились. Подготовьте полный план заново.'
    return null
  }
  return (
    legacyRoadLayoutProblem(scheme.source) ??
    (scheme.roadLayout.nodes.length || scheme.roadLayout.links.length ? ROAD_LAYOUT_PROBLEM : null)
  )
}
