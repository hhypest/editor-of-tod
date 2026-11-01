import { z } from 'zod'
import type { RoadLayout, RoadObjectLink } from './road-layout'

const text = z.string().max(5_000)
/** Raw input belongs to the existing sign-post form; no physical distance is inferred. */
export const roadObjectLinkDraftSchema = z.strictObject({
  nodeId: text,
  role: z.enum(['main-repeat', 'side-warning', 'tee-branch']),
  installationKnown: z.boolean(),
  installationFrom: z.enum(['L0', 'E', 'node-axis']),
  installationMetres: text,
})
export type RoadObjectLinkDraft = z.infer<typeof roadObjectLinkDraftSchema>

export function createRoadObjectLinkDraft(link?: RoadObjectLink): RoadObjectLinkDraft {
  return {
    nodeId: link ? String(link.nodeId) : '',
    role: link?.role ?? 'main-repeat',
    installationKnown: link?.installation != null,
    installationFrom: link?.installation?.from ?? 'node-axis',
    installationMetres: link?.installation ? String(link.installation.metres) : '',
  }
}

export class RoadObjectLinkEditError extends Error {}

/** Undefined means an older form: retain the association, including historical provenance. */
export function editedRoadObjectLinks(
  layout: RoadLayout,
  placementId: number,
  input: RoadObjectLinkDraft | undefined,
): RoadObjectLink[] {
  if (input === undefined) return layout.links
  const parsed = roadObjectLinkDraftSchema.safeParse(input)
  if (!parsed.success)
    throw new RoadObjectLinkEditError('Проверьте поля связи стойки с примыканием.')
  const draft = parsed.data
  if (!draft.nodeId.trim()) return layout.links.filter((link) => link.placementId !== placementId)
  const nodeId = Number(draft.nodeId)
  const node = layout.nodes.find((item) => item.id === nodeId)
  if (!/^[1-9]\d*$/.test(draft.nodeId) || !Number.isSafeInteger(nodeId) || !node)
    throw new RoadObjectLinkEditError(
      'Узел связи больше не существует. Выберите примыкание заново.',
    )
  if ((node.kind === 'terminal-tee') !== (draft.role === 'tee-branch'))
    throw new RoadObjectLinkEditError('Назначение связи не соответствует виду выбранного узла.')
  let installation: RoadObjectLink['installation'] = null
  if (draft.installationKnown) {
    const raw = draft.installationMetres.trim().replace(',', '.')
    const metres = Number(raw)
    if (!/^\d+(?:\.\d+)?$/.test(raw) || !Number.isFinite(metres))
      throw new RoadObjectLinkEditError(
        'Расстояние установки стойки: введите неотрицательное число в метрах или снимите отметку о заполненном замере.',
      )
    installation = { from: draft.installationFrom, metres }
  }
  const previous = layout.links.find((link) => link.placementId === placementId)
  if (
    previous?.nodeId === nodeId &&
    previous.role === draft.role &&
    previous.installation?.from === installation?.from &&
    previous.installation?.metres === installation?.metres
  )
    return layout.links
  const next: RoadObjectLink = {
    placementId,
    nodeId,
    role: draft.role,
    origin: 'manual',
    installation,
  }
  return previous
    ? layout.links.map((link) => (link.placementId === placementId ? next : link))
    : [...layout.links, next]
}
