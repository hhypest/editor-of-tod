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

// Packing projects the same inputs repeatedly. Bound both the number and size of cached keys;
// the complete canonical value remains the key, so in-place edits cannot reuse a stale hash.
const basisCache = new Map<string, string>()

/** Input identity only, not a signature or proof of normative compliance. */
export function roadCalculationBasis(value: unknown): string {
  const serialized = JSON.stringify(canonical(value)) ?? ''
  const previous = basisCache.get(serialized)
  if (previous !== undefined) return previous
  let hash = 0xcbf29ce484222325n
  for (const byte of new TextEncoder().encode(serialized)) {
    hash ^= BigInt(byte)
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn
  }
  const result = hash.toString(16).padStart(16, '0')
  if (serialized.length <= 128 * 1024) {
    if (basisCache.size >= 8) basisCache.delete(basisCache.keys().next().value!)
    basisCache.set(serialized, result)
  }
  return result
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
