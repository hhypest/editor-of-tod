import { evidenceFingerprint } from './evidence-fingerprint.ts'
import { postMetres, type PostDistance } from './post-distance.ts'

/**
 * Исходные данные записанного решения о скорости (ADR-0007) для его отпечатка. Модуль не зависит
 * от схемы проекта (`model.ts`): им пользуется и миграция формата v9 → v10.
 */

type SpeedSource = {
  parameters: {
    location: string
    speedConditions: unknown
    approachSpeedKmh: number | null
    speedStagesKmh: readonly number[]
    signDistancesMetres: Parameters<typeof postMetres>[1]
  }
  placements: ReadonlyArray<
    | { kind: 'sign-post'; signIds: readonly string[]; distance?: PostDistance | null }
    | { kind: string }
  >
}

/** Знаки, от которых зависит решение о скорости: ограничение и его отмена. */
const SPEED_DECISION_SIGN = /^3\.(?:24|25|31)(?:_|$)/

function isPost(
  item: SpeedSource['placements'][number],
): item is { kind: 'sign-post'; signIds: readonly string[]; distance?: PostDistance | null } {
  return item.kind === 'sign-post'
}

/**
 * Знаки скорости на листе для отпечатка решения: подход, расстояние в метрах и коды знаков 3.24,
 * 3.25 и 3.31. Координаты на листе, номера стоек и прочие знаки в отпечаток не входят: их
 * изменение не меняет решения о скорости (issue #99). Стойка без расстояния учитывается по
 * составу знаков — её места на местности программа не знает (ADR-0008).
 */
function speedSigns(source: SpeedSource): string[] {
  return source.placements
    .flatMap((item) => {
      if (!isPost(item)) return []
      const codes = item.signIds.filter((code) => SPEED_DECISION_SIGN.test(code)).sort()
      if (!codes.length) return []
      return [
        {
          approach: item.distance?.approach ?? null,
          metres: item.distance
            ? postMetres(item.distance, source.parameters.signDistancesMetres)
            : null,
          codes,
        },
      ]
    })
    .map((item) => JSON.stringify(item))
    .sort()
}

/** Отпечаток исходных данных решения о скорости. */
export function speedInputFingerprint(source: SpeedSource): string {
  const p = source.parameters
  return evidenceFingerprint([
    p.location,
    p.speedConditions,
    p.approachSpeedKmh,
    p.speedStagesKmh,
    speedSigns(source),
  ])
}

/**
 * Отпечаток записей, сделанных до issue #99: включал стойки целиком. Совпадение с ним тоже
 * означает, что исходные данные не менялись, — иначе обновление программы сделало бы все
 * прежние записи устаревшими.
 */
export function legacySpeedInputFingerprint(source: SpeedSource): string {
  const p = source.parameters
  return evidenceFingerprint([
    p.location,
    p.speedConditions,
    p.approachSpeedKmh,
    p.speedStagesKmh,
    source.placements.filter((item) => item.kind === 'sign-post'),
  ])
}
