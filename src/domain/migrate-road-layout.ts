import { legacyV1Schema } from './legacy-v1.ts'
import { legacyRoadFieldsSchema } from './legacy-road-layout.ts'
import {
  emptyRoadLayout,
  roadLayoutSchema,
  type RoadLayout,
  type RoadObjectLink,
} from './road-layout.ts'

type Source = { kind: string; originalJson?: string }

/** Only read the source. Never recreate deleted placements or overwrite edited objects. */
export function migrateRoadLayout(
  source: Source,
  placements: readonly { id: number; kind: string }[],
): RoadLayout {
  const empty = emptyRoadLayout()
  if (source.kind !== 'legacy-html-v1' || !source.originalJson) return empty
  let value: unknown
  try {
    value = JSON.parse(source.originalJson)
  } catch {
    return empty
  }
  const parsed = legacyV1Schema.safeParse(value)
  const extras = legacyRoadFieldsSchema.safeParse(value)
  // Old v11 files may contain malformed extensions. Keep opening them under the legacy guard.
  if (!parsed.success || !extras.success) return empty
  const { junc = [], tee } = extras.data.params
  const nodes: RoadLayout['nodes'] = junc.map((node) => ({
    id: node.id,
    kind: 'junction',
    origin: 'legacy-v1',
    position:
      node.app === 'L'
        ? { approach: 'left', from: 'L0', metres: node.d }
        : { approach: 'right', from: 'E', metres: node.d },
    sheetOffsetXSvg: node.px ?? null,
    side: node.edge,
    roadKind: node.kind,
    name: node.name,
    sideWarningRequested: node.side,
  }))
  let nextNodeId = Math.max(0, ...nodes.map((node) => node.id)) + 1
  const teeId = tee?.on ? nextNodeId++ : null
  if (tee?.on && teeId !== null)
    nodes.push({
      id: teeId,
      kind: 'terminal-tee',
      origin: 'legacy-v1',
      position:
        tee.app === 'L'
          ? { approach: 'left', from: 'L0', metres: tee.d }
          : { approach: 'right', from: 'E', metres: tee.d },
      sheetOffsetXSvg: tee.px ?? null,
      branchNames: { up: tee.n1, down: tee.n2 },
    })
  const current = new Map(placements.map((placement) => [placement.id, placement]))
  const junctions = new Set(junc.map((node) => node.id))
  const links: RoadObjectLink[] = []
  for (const [index, object] of parsed.data.objects.entries()) {
    const placement = current.get(object.id)
    if (!placement || (object.t === 'post' ? 'sign-post' : 'element') !== placement.kind) continue
    const extra = extras.data.objects[index]!
    const candidates: Array<{ nodeId: number; role: RoadObjectLink['role'] }> = []
    if (extra.jrep !== undefined && junctions.has(extra.jrep))
      candidates.push({ nodeId: extra.jrep, role: 'main-repeat' })
    if (extra.jside !== undefined && junctions.has(extra.jside))
      candidates.push({ nodeId: extra.jside, role: 'side-warning' })
    if ((extra.tee === 1 || extra.tee === true) && teeId !== null)
      candidates.push({ nodeId: teeId, role: 'tee-branch' })
    // A conflicting or dangling producer tag is not guessed. Raw source and guard retain it.
    const tagged =
      Number(extra.jrep !== undefined) +
      Number(extra.jside !== undefined) +
      Number(extra.tee === 1 || extra.tee === true)
    if (tagged !== 1 || candidates.length !== 1) continue
    links.push({
      placementId: object.id,
      ...candidates[0]!,
      origin: 'legacy-v1',
      installation: null,
    })
  }
  const result = roadLayoutSchema.safeParse({ nextNodeId, nodes, links })
  return result.success ? result.data : empty
}
