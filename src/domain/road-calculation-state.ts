import type { RoadLayout } from './road-layout'

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b, 'en'))
        .map(([key, item]) => [key, canonical(item)]),
    )
  return value
}
export function roadValuesEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b))
}

/** Input identity only, not a signature or proof of normative compliance. */
export function roadCalculationBasis(value: unknown): string {
  let hash = 0xcbf29ce484222325n
  for (const byte of new TextEncoder().encode(JSON.stringify(canonical(value)))) {
    hash ^= BigInt(byte)
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn
  }
  return hash.toString(16).padStart(16, '0')
}
export function markRoadCalculationEdited(layout: RoadLayout, id: number): RoadLayout {
  return {
    ...layout,
    links: layout.links.map((link) =>
      link.placementId === id && link.calculation?.state === 'automatic'
        ? { ...link, calculation: { ...link.calculation, state: 'modified' as const } }
        : link,
    ),
  }
}
