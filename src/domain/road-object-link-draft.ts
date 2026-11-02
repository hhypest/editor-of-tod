import { z } from 'zod'
import { branchPlacementSchema, type RoadLayout, type RoadObjectLink } from './road-layout.ts'

const text = z.string().max(5_000)
export const branchPlacementDraftSchema = z.strictObject({
  enabled: z.boolean(),
  branch: z.enum(['', 'up', 'down']),
  alongSvg: text,
  acrossSvg: text,
  rotation: z.enum(['0', '90', '180', '270']),
})
/** Raw input belongs to the existing sign-post form; no physical distance is inferred. */
export const roadObjectLinkDraftSchema = z.strictObject({
  nodeId: text,
  role: z.enum(['main-repeat', 'side-warning', 'tee-branch']),
  installationKnown: z.boolean(),
  installationFrom: z.enum(['L0', 'E', 'node-axis']),
  installationMetres: text,
  branchPlacement: branchPlacementDraftSchema.optional(),
})
export type RoadObjectLinkDraft = z.infer<typeof roadObjectLinkDraftSchema>

export function createRoadObjectLinkDraft(link?: RoadObjectLink): RoadObjectLinkDraft {
  return {
    nodeId: link ? String(link.nodeId) : '',
    role: link?.role ?? 'main-repeat',
    installationKnown: link?.installation != null,
    installationFrom: link?.installation?.from ?? 'node-axis',
    installationMetres: link?.installation ? String(link.installation.metres) : '',
    branchPlacement: {
      enabled: link?.branchPlacement != null,
      branch: link?.branchPlacement?.branch ?? '',
      alongSvg: String(link?.branchPlacement?.alongSvg ?? 140),
      acrossSvg: String(link?.branchPlacement?.acrossSvg ?? 100),
      rotation: String(link?.branchPlacement?.rotation ?? 0) as '0' | '90' | '180' | '270',
    },
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
  const previous = layout.links.find((link) => link.placementId === placementId)
  if (!draft.nodeId.trim()) {
    if (previous?.branchPlacement && draft.branchPlacement?.enabled !== false)
      throw new RoadObjectLinkEditError('Сначала явно снимите размещение стойки на ветви.')
    return layout.links.filter((link) => link.placementId !== placementId)
  }
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
  if (
    previous?.branchPlacement &&
    (previous.nodeId !== nodeId || previous.role !== draft.role) &&
    draft.branchPlacement?.enabled !== false
  )
    throw new RoadObjectLinkEditError('Сначала явно снимите размещение стойки на ветви.')
  let branchPlacement = previous?.branchPlacement
  if (draft.branchPlacement !== undefined) {
    branchPlacement = undefined
    if (draft.branchPlacement.enabled) {
      const along = draft.branchPlacement.alongSvg.trim().replace(',', '.')
      const across = draft.branchPlacement.acrossSvg.trim().replace(',', '.')
      const branch = branchPlacementSchema.safeParse({
        branch: draft.branchPlacement.branch,
        alongSvg: Number(along),
        acrossSvg: Number(across),
        rotation: Number(draft.branchPlacement.rotation),
      })
      if (!/^\d+(?:\.\d+)?$/.test(along) || !/^-?\d+(?:\.\d+)?$/.test(across) || !branch.success)
        throw new RoadObjectLinkEditError(
          'Размещение на ветви: выберите ветвь и заполните условные отступы числами (не более 1 000 000 по модулю). Отступ вдоль ветви неотрицательный.',
        )
      if (
        draft.role === 'main-repeat' ||
        (node.kind === 'junction' && node.side !== branch.data.branch)
      )
        throw new RoadObjectLinkEditError('Ветвь не соответствует узлу или назначению стойки.')
      branchPlacement = branch.data
    }
  }
  if (
    previous?.nodeId === nodeId &&
    previous.role === draft.role &&
    previous.installation?.from === installation?.from &&
    previous.installation?.metres === installation?.metres &&
    previous.branchPlacement?.branch === branchPlacement?.branch &&
    previous.branchPlacement?.alongSvg === branchPlacement?.alongSvg &&
    previous.branchPlacement?.acrossSvg === branchPlacement?.acrossSvg &&
    previous.branchPlacement?.rotation === branchPlacement?.rotation
  )
    return layout.links
  const next: RoadObjectLink = {
    placementId,
    nodeId,
    role: draft.role,
    origin: 'manual',
    installation,
    ...(branchPlacement ? { branchPlacement } : {}),
  }
  return previous
    ? layout.links.map((link) => (link.placementId === placementId ? next : link))
    : [...layout.links, next]
}
