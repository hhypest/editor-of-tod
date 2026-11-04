import type { Scheme } from './model'
import type { ParameterBasis } from './decision-evidence-schema'
import { roadCalculationBasis } from './road-calculation-state'

export function roadAutomationBasis(
  scheme: {
    source: { kind: string; originalJson?: string }
    roadLayout: Scheme['roadLayout']
  } & Partial<Pick<Scheme, 'parameters' | 'template' | 'placements' | 'roadObjectExclusions'>>,
  profile: readonly ParameterBasis[],
): string {
  return roadCalculationBasis({
    version: 'road-layout-v1',
    source: scheme.source,
    parameters: scheme.parameters,
    template: scheme.template?.code,
    nodes: scheme.roadLayout.nodes,
    sources: [
      ...(scheme.placements ?? []),
      ...(scheme.roadObjectExclusions?.objects ?? []).map((item) => item.post),
    ]
      .filter((post) => post.templateSlot)
      .sort((a, b) => a.id - b.id),
    profile,
  })
}
export function roadAutomationCurrent(scheme: Parameters<typeof roadAutomationBasis>[0]): boolean {
  const receipt = scheme.roadLayout.automation
  if (!receipt || !scheme.placements) return false
  const all = [
    ...scheme.placements,
    ...(scheme.roadObjectExclusions?.objects ?? []).map((item) => item.post),
  ]
  const ids = new Set(all.map((post) => post.id))
  if (
    receipt.baseIds.some((id) => !ids.has(id)) ||
    receipt.outputs.some(
      (output) =>
        !ids.has(output.placementId) ||
        !scheme.roadLayout.nodes.some((node) => node.id === output.nodeId) ||
        ![
          ...scheme.roadLayout.links,
          ...(scheme.roadObjectExclusions?.objects ?? []).map((item) => item.link),
          ...(scheme.roadLayout.detached ?? []).map((item) => item.previousLink),
        ].some(
          (link) =>
            link.placementId === output.placementId &&
            link.nodeId === output.nodeId &&
            (link.calculation?.ruleId !== 'project-road-layout-v1' ||
              link.calculation.slot === output.slot),
        ),
    )
  )
    return false
  return Boolean(
    receipt && scheme.parameters && receipt.basis === roadAutomationBasis(scheme, receipt.profile),
  )
}

export function roadDrawingNodes(s: Scheme) {
  if (!roadAutomationCurrent(s)) return s.roadLayout.nodes
  const range = s.roadLayout.automation!.profile.find(
    (p) =>
      p.id ===
      (s.parameters.location === 'in' ? 'project-junction-range-in' : 'project-junction-range-out'),
  )?.value
  if (typeof range !== 'number') return s.roadLayout.nodes
  const tee = s.roadLayout.nodes.find(
    (n) => n.kind === 'terminal-tee' && n.position.metres <= range,
  )
  return s.roadLayout.nodes.filter(
    (n) =>
      n.position.metres <= range &&
      !(n.kind === 'junction' && tee?.position.approach === n.position.approach),
  )
}
