import type { Scheme } from './model'
import { schemeLayout } from './placement-workspace'

/** RP4: freeze manual geometry before changing/removing its owner; automatic outputs are disposable. */
export function detachRoadNodeObjects(scheme: Scheme, nodeId: number): Scheme {
  const layout = schemeLayout(scheme),
    active = new Map(scheme.placements.map((post) => [post.id, post]))
  const detached = [...(scheme.roadLayout.detached ?? [])],
    removed = new Set<number>()
  const all = [
    ...scheme.roadLayout.links.map((link) => ({ link, post: active.get(link.placementId) })),
    ...(scheme.roadObjectExclusions?.objects ?? []),
  ]
  for (const { post, link } of all) {
    if (link.nodeId !== nodeId || !post || post.kind !== 'sign-post') continue
    const excluded = scheme.roadObjectExclusions?.objects.some((item) => item.post.id === post.id)
    if (link.calculation?.state === 'automatic' && !excluded) {
      removed.add(post.id)
      continue
    }
    const branch = layout.branch(post.id)
    const xy = branch ?? layout.coordinates(post)
    // Excluded branch objects are absent from active links: compute them against their original node.
    const saved =
      branch ??
      schemeLayout({
        ...scheme,
        roadLayout: {
          ...scheme.roadLayout,
          links: [...scheme.roadLayout.links.filter((l) => l.placementId !== post.id), link],
        },
      }).branch(post.id)
    const value = {
      placementId: post.id,
      nodeId,
      reason: 'Узел изменён или удалён; ручные данные и положение сохранены независимо.',
      previousLink: link,
      x: saved?.x ?? xy.x,
      y: saved?.y ?? xy.y,
      rotation: saved?.rotation ?? (0 as const),
    }
    const index = detached.findIndex((item) => item.placementId === post.id)
    if (index < 0) detached.push(value)
    else detached[index] = value
  }
  const exclusions = scheme.roadObjectExclusions
    ? {
        ...scheme.roadObjectExclusions,
        objects: scheme.roadObjectExclusions.objects.filter((item) => !removed.has(item.post.id)),
      }
    : undefined
  const next = {
    ...scheme,
    placements: scheme.placements.filter((post) => !removed.has(post.id)),
    roadLayout: {
      ...scheme.roadLayout,
      links: scheme.roadLayout.links.filter((link) => link.nodeId !== nodeId),
      detached: detached.filter((item) => !removed.has(item.placementId)),
    },
    ...(exclusions?.objects.length ? { roadObjectExclusions: exclusions } : {}),
  }
  if (exclusions && !exclusions.objects.length) delete next.roadObjectExclusions
  return next
}
