import type { RoadLayout, RoadObjectLink } from './road-layout'
import type { RoadSheetNode } from './road-sheet'
import { decimalComma } from './number-format.ts'

/** Retained main-road data of these posts are inactive until explicit detachment. */
export function branchPostIds(layout: RoadLayout): ReadonlySet<number> {
  return new Set(
    layout.links.filter((link) => link.branchPlacement).map((link) => link.placementId),
  )
}

export function branchPostPositions(layout: RoadLayout, nodes: readonly RoadSheetNode[]) {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  return new Map(
    layout.links.flatMap((link) => {
      const branch = link.branchPlacement,
        node = byId.get(link.nodeId)
      return branch && node
        ? [
            [
              link.placementId,
              {
                x: node.x + branch.acrossSvg,
                y: 460 + (branch.branch === 'up' ? -1 : 1) * branch.alongSvg,
                rotation: branch.rotation,
                nodeId: link.nodeId,
                link,
              },
            ] as const,
          ]
        : []
    }),
  )
}

export function branchInstallationCaption(link: RoadObjectLink): string | null {
  if (!link.installation) return null
  return `${decimalComma(link.installation.metres)} м от ${link.installation.from === 'node-axis' ? 'оси узла' : link.installation.from}`
}

/** Exact quarter turns, including the complete annotation extent. */
export function rotatePostBox(
  box: [number, number, number, number],
  cx: number,
  cy: number,
  rotation: 0 | 90 | 180 | 270,
): [number, number, number, number] {
  const points = [
    [box[0], box[1]],
    [box[0] + box[2], box[1]],
    [box[0], box[1] + box[3]],
    [box[0] + box[2], box[1] + box[3]],
  ].map(([x, y]) => {
    const dx = x! - cx,
      dy = y! - cy
    const [rx, ry] =
      rotation === 90
        ? [-dy, dx]
        : rotation === 180
          ? [-dx, -dy]
          : rotation === 270
            ? [dy, -dx]
            : [dx, dy]
    return [cx + rx!, cy + ry!] as const
  })
  const xs = points.map(([x]) => x),
    ys = points.map(([, y]) => y)
  const left = Math.min(...xs),
    top = Math.min(...ys)
  return [left, top, Math.max(...xs) - left, Math.max(...ys) - top]
}
