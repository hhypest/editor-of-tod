import { schemeSchema, type Scheme } from './model'
import type { RoadNode } from './road-layout'
import { roadNodeDraftSchema, type RoadNodeDraft } from './road-node-draft'

export const LINKED_ROAD_NODE_DELETE_PROBLEM =
  'У примыкания есть связанные объекты. Его удаление пока недоступно: сохранение отсоединённых ручных правок ещё разрабатывается. Объекты и связи сохранены.'

export class RoadNodeEditError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RoadNodeEditError'
  }
}

export function newRoadNodeDraft(nodeKind: RoadNode['kind']): RoadNodeDraft {
  return {
    kind: 'road-node',
    id: null,
    nodeKind,
    approach: 'left',
    side: 'down',
    roadKind: 'road',
    name: '',
    branchUp: '',
    branchDown: '',
    metres: '',
    sheetOffsetXSvg: '',
    sideWarningRequested: false,
  }
}

export function createRoadNodeDraft(node: RoadNode): RoadNodeDraft {
  return {
    ...newRoadNodeDraft(node.kind),
    id: node.id,
    approach: node.position.approach,
    metres: String(node.position.metres),
    sheetOffsetXSvg: node.sheetOffsetXSvg === null ? '' : String(node.sheetOffsetXSvg),
    ...(node.kind === 'junction'
      ? {
          side: node.side,
          roadKind: node.roadKind,
          name: node.name,
          sideWarningRequested: node.sideWarningRequested,
        }
      : { branchUp: node.branchNames.up, branchDown: node.branchNames.down }),
  }
}

function checked(scheme: Scheme): Scheme {
  const result = schemeSchema.safeParse(scheme)
  if (!result.success)
    throw new RoadNodeEditError(
      result.error.issues[0]?.message ?? 'Не удалось проверить данные примыкания.',
    )
  return result.data
}

/** Edit the node only: linked objects, installation distances and plate values stay. */
export function saveRoadNode(scheme: Scheme, input: RoadNodeDraft): Scheme {
  const parsed = roadNodeDraftSchema.safeParse(input)
  if (!parsed.success)
    throw new RoadNodeEditError('Проверьте поля примыкания: данные формы повреждены.')
  const draft = parsed.data
  const existing =
    draft.id === null ? null : scheme.roadLayout.nodes.find((node) => node.id === draft.id)
  if (draft.id !== null && (!existing || existing.kind !== draft.nodeKind))
    throw new RoadNodeEditError(
      'Примыкание больше не существует или изменило вид. Выберите его заново.',
    )
  const value = draft.metres.trim().replace(',', '.')
  const metres = Number(value)
  if (!/^\d+(?:\.\d+)?$/.test(value) || !Number.isFinite(metres))
    throw new RoadNodeEditError(
      'Расстояние до оси примыкания: введите неотрицательное число в метрах.',
    )
  if (
    draft.nodeKind === 'terminal-tee' &&
    scheme.roadLayout.nodes.some((node) => node.kind === 'terminal-tee' && node.id !== draft.id)
  )
    throw new RoadNodeEditError('В проекте уже есть конечный Т-перекрёсток. Измените существующий.')
  let sheetOffsetXSvg = existing?.sheetOffsetXSvg ?? null
  if (draft.sheetOffsetXSvg !== undefined) {
    const offset = draft.sheetOffsetXSvg.trim().replace(',', '.')
    if (offset !== '' && (!/^-?\d+(?:\.\d+)?$/.test(offset) || !Number.isFinite(Number(offset))))
      throw new RoadNodeEditError(
        'Условный отступ рисунка: введите число или оставьте поле пустым для автоматической компоновки.',
      )
    sheetOffsetXSvg = offset === '' ? null : Number(offset)
  }
  const id = draft.id ?? scheme.roadLayout.nextNodeId
  const node: RoadNode = {
    id,
    origin: existing?.origin ?? 'manual',
    position:
      draft.approach === 'left'
        ? { approach: 'left', from: 'L0', metres }
        : { approach: 'right', from: 'E', metres },
    sheetOffsetXSvg,
    ...(draft.nodeKind === 'junction'
      ? {
          kind: 'junction',
          side: draft.side,
          roadKind: draft.roadKind,
          name: draft.name,
          sideWarningRequested: draft.sideWarningRequested,
        }
      : { kind: 'terminal-tee', branchNames: { up: draft.branchUp, down: draft.branchDown } }),
  }
  return checked({
    ...scheme,
    roadLayout: {
      ...scheme.roadLayout,
      nodes:
        draft.id === null
          ? [...scheme.roadLayout.nodes, node]
          : scheme.roadLayout.nodes.map((item) => (item.id === id ? node : item)),
      nextNodeId: draft.id === null ? id + 1 : scheme.roadLayout.nextNodeId,
    },
  })
}

/** Linked-node removal waits for persisted detached-object states (RP4); never delete objects implicitly. */
export function removeRoadNode(scheme: Scheme, id: number): Scheme {
  if (!scheme.roadLayout.nodes.some((node) => node.id === id))
    throw new RoadNodeEditError('Примыкание не найдено.')
  if (scheme.roadLayout.links.some((link) => link.nodeId === id))
    throw new RoadNodeEditError(LINKED_ROAD_NODE_DELETE_PROBLEM)
  return checked({
    ...scheme,
    roadLayout: {
      ...scheme.roadLayout,
      nodes: scheme.roadLayout.nodes.filter((node) => node.id !== id),
    },
  })
}
