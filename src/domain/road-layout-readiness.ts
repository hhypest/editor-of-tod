import { legacyRoadLayoutProblem } from './legacy-road-layout.ts'
import type { RoadLayout } from './road-layout.ts'

export const ROAD_LAYOUT_PROBLEM =
  'Данные примыканий сохранены. Рисунок ветвей доступен для сверки; перенос связанных объектов и автоматика ещё не реализованы. Автоматическая перестройка и выпуск этого проекта недоступны; сохранение проекта и черновик для сверки доступны.'

/** A v12 project must not bypass protection by having no legacy source. */
export function roadLayoutProblem(scheme: {
  source: { kind: string; originalJson?: string }
  roadLayout: RoadLayout
}): string | null {
  return (
    legacyRoadLayoutProblem(scheme.source) ??
    (scheme.roadLayout.nodes.length || scheme.roadLayout.links.length ? ROAD_LAYOUT_PROBLEM : null)
  )
}
