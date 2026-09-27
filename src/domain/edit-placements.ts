import { schemeSchema, type Scheme, type SignPlacement } from './model'

type Placement = Scheme['placements'][number]
type Anchor = SignPlacement['position']['anchor']
type BaseDraft = { id: number | null; anchor: Anchor; x: string; y: string }

export type PlacementDraft =
  | (BaseDraft & {
      kind: 'sign-post'
      side: SignPlacement['side']
      stand: SignPlacement['stand']
      signCodes: string
      distanceLabel: string
    })
  | (BaseDraft & {
      kind: 'element'
      elementKind: Extract<Placement, { kind: 'element' }>['elementKind']
      width: string
      height: string
      text: string
      fontSize: string
      bold: boolean
    })

export class PlacementEditError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PlacementEditError'
  }
}

export function createPlacementDraft(placement: Placement): PlacementDraft {
  if (placement.kind === 'sign-post') {
    return {
      kind: 'sign-post',
      id: placement.id,
      anchor: placement.position.anchor,
      x: String(placement.position.offsetXSvg),
      y: String(placement.position.offsetYSvg),
      side: placement.side,
      stand: placement.stand,
      signCodes: placement.signIds.join(', '),
      distanceLabel: placement.distanceLabel ?? '',
    }
  }
  return {
    kind: 'element',
    id: placement.id,
    anchor: placement.position.anchor,
    x: String(placement.position.offsetXSvg),
    y: String(placement.position.ySvg),
    elementKind: placement.elementKind,
    width: String(placement.sizeSvg.width),
    height: String(placement.sizeSvg.height),
    text: placement.text ?? '',
    fontSize: placement.fontSizeSvg?.toString() ?? '',
    bold: placement.bold,
  }
}

export function newSignDraft(): PlacementDraft {
  return {
    kind: 'sign-post',
    id: null,
    anchor: 'abs',
    x: '0',
    y: '0',
    side: 'up',
    stand: 'right',
    signCodes: '',
    distanceLabel: '',
  }
}

export function newTextDraft(): PlacementDraft {
  return {
    kind: 'element',
    id: null,
    anchor: 'abs',
    x: '0',
    y: '0',
    elementKind: 'text',
    width: '0',
    height: '0',
    text: '',
    fontSize: '14',
    bold: false,
  }
}

export function newSymbolDraft(
  kind: 'reg' | 'car' | 'cone' | 'complex' | 'pit',
  x: number,
  y: number,
): PlacementDraft {
  const sizes = {
    reg: [30, 48],
    car: [92, 65],
    cone: [25, 31],
    complex: [82, 65],
    pit: [80, 36],
  } as const
  return {
    kind: 'element',
    id: null,
    anchor: 'abs',
    x: String(x),
    y: String(y),
    elementKind: kind,
    width: String(sizes[kind][0]),
    height: String(sizes[kind][1]),
    text: '',
    fontSize: '',
    bold: false,
  }
}

function numberField(value: string, name: string, minimum?: number): number {
  const normalized = value.trim().replace(',', '.')
  if (!/^-?\d+(?:\.\d+)?$/.test(normalized)) {
    throw new PlacementEditError(`Поле «${name}»: введите число.`)
  }
  const number = Number(normalized)
  if (!Number.isFinite(number) || (minimum !== undefined && number < minimum)) {
    throw new PlacementEditError(`Поле «${name}»: недопустимое значение.`)
  }
  return number
}

function optionalFontSize(value: string): number | null {
  if (!value.trim()) return null
  const size = numberField(value, 'Размер шрифта', 0)
  if (size === 0) throw new PlacementEditError('Размер шрифта должен быть положительным.')
  return size
}

function placementFromDraft(draft: PlacementDraft, id: number): Placement {
  const x = numberField(draft.x, 'X')
  const y = numberField(draft.y, 'Y')
  if (draft.kind === 'sign-post') {
    const signIds = draft.signCodes
      .split(/[,;\n]/)
      .map((code) => code.trim())
      .filter(Boolean)
    if (!signIds.length || signIds.length > 20 || signIds.some((code) => code.length > 120)) {
      throw new PlacementEditError('На стойке должно быть от 1 до 20 кодов знаков до 120 символов.')
    }
    return {
      kind: 'sign-post',
      id,
      generatedByTemplate: false,
      position: { anchor: draft.anchor, offsetXSvg: x, offsetYSvg: y },
      side: draft.side,
      stand: draft.stand,
      signIds,
      distanceLabel: draft.distanceLabel.trim() || null,
    }
  }
  if (draft.elementKind === 'text' && !draft.text.trim()) {
    throw new PlacementEditError('Текстовая надпись не может быть пустой.')
  }
  return {
    kind: 'element',
    id,
    generatedByTemplate: false,
    elementKind: draft.elementKind,
    position: { anchor: draft.anchor, offsetXSvg: x, ySvg: y },
    sizeSvg: {
      width: numberField(draft.width, 'Ширина', 0),
      height: numberField(draft.height, 'Высота', 0),
    },
    text: draft.text || null,
    fontSizeSvg: optionalFontSize(draft.fontSize),
    bold: draft.bold,
  }
}

function checked(candidate: Scheme): Scheme {
  const result = schemeSchema.safeParse(candidate)
  if (!result.success) {
    const issue = result.error.issues[0]
    throw new PlacementEditError(
      `Поле «${issue?.path.join('.') || 'проект'}» не прошло проверку: ${issue?.message || 'недопустимое значение'}.`,
    )
  }
  return result.data
}

export function savePlacement(scheme: Scheme, draft: PlacementDraft): Scheme {
  const existing = draft.id === null ? undefined : scheme.placements.find((p) => p.id === draft.id)
  if (draft.id !== null && (!existing || existing.kind !== draft.kind)) {
    throw new PlacementEditError('Выбранный объект больше не существует или изменил тип.')
  }
  if (
    existing?.kind === 'element' &&
    draft.kind === 'element' &&
    existing.elementKind !== draft.elementKind
  ) {
    throw new PlacementEditError('Тип существующего элемента менять нельзя.')
  }
  const id = draft.id ?? scheme.nextPlacementId
  const placement = placementFromDraft(draft, id)
  return checked({
    ...scheme,
    placements:
      draft.id === null
        ? [...scheme.placements, placement]
        : scheme.placements.map((item) => (item.id === id ? placement : item)),
    nextPlacementId: draft.id === null ? id + 1 : scheme.nextPlacementId,
  })
}

export function removePlacement(scheme: Scheme, id: number): Scheme {
  if (!scheme.placements.some((placement) => placement.id === id)) {
    throw new PlacementEditError(`Объект ${id} не найден.`)
  }
  return checked({
    ...scheme,
    placements: scheme.placements.filter((placement) => placement.id !== id),
  })
}
