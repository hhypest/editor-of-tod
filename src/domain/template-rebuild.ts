import { schemeSchema, type Scheme } from './model'
import type { NormativeRules } from './normative-parameters'
import { rebuildTemplatePlacements, TemplateBuildError } from './template-placements'

/**
 * Автоматическая перестройка типовых объектов при применении правок этапа 2 (П5, issue #106).
 *
 * Перестраиваются только объекты шаблона (`generatedByTemplate`) и только если шаблон уже был
 * собран: это видно и по `templateSlot` у изменённых вручную объектов. Проект без следов
 * шаблона остаётся как есть, его собирает кнопка этапа 3. Ручные
 * объекты и изменённые вручную слоты не трогаются (`rebuildTemplatePlacements`). Перестройка
 * входит в то же действие истории, что и правка, поэтому одна отмена возвращает и параметры,
 * и объекты.
 */

type Placement = Scheme['placements'][number]

/** Параметры, от которых зависит раскладка шаблона (`buildTemplatePlacements`). */
function templateInputs(scheme: Scheme): unknown {
  const p = scheme.parameters
  return [
    scheme.template.code,
    p.location,
    p.regulation.mode,
    p.speedStagesKmh,
    p.approachSpeedKmh,
    p.yellowTemporarySigns,
    p.frontStyle,
    p.workZones[scheme.template.code] ?? null,
    p.signDistancesMetres,
  ]
}

export function templateInputsChanged(previous: Scheme, next: Scheme): boolean {
  return JSON.stringify(templateInputs(previous)) !== JSON.stringify(templateInputs(next))
}

const POST_NAMES: Record<string, string> = {
  warning: 'знак 1.25',
  speed1: 'первая ступень 3.24',
  narrowing: 'сужение',
  'zone-speed': 'скорость в зоне',
  start: 'начало работ',
  end: 'конец ограничений',
}
const ELEMENT_NAMES: Record<string, string> = {
  reg: 'регулировщик',
  complex: 'переносной комплекс',
  car: 'автомобиль прикрытия',
  pit: 'место работ',
}

/** Название объекта шаблона для сообщения: «первая ступень 3.24 слева», «регулировщик». */
export function slotTitle(placement: Placement): string {
  const slot = placement.templateSlot ?? ''
  const post = /^post2:([LR]):(.+)$/.exec(slot)
  if (post) return `${POST_NAMES[post[2]!] ?? post[2]} ${post[1] === 'L' ? 'слева' : 'справа'}`
  if (placement.kind === 'element') return ELEMENT_NAMES[placement.elementKind] ?? 'объект'
  return 'стойка'
}

/** Содержимое объекта без номера: по нему видно, изменился ли объект слота. */
function content(placement: Placement): string {
  const { id: _id, ...rest } = placement
  return JSON.stringify(rest)
}

export type TemplateChanges = {
  changed: string[]
  added: string[]
  removed: string[]
  /** Изменённые вручную объекты шаблона, оставленные без замены. */
  keptSlots: number
  /** Изменённые вручную объекты прежней раскладки, места которым в новой нет. */
  staleSlots: number
}

function diff(before: readonly Placement[], after: readonly Placement[]) {
  const generated = (list: readonly Placement[]) =>
    new Map(
      list
        .filter((placement) => placement.generatedByTemplate && placement.templateSlot)
        .map((placement) => [placement.templateSlot!, placement]),
    )
  const old = generated(before)
  const now = generated(after)
  const titles = (slots: Iterable<string>, from: Map<string, Placement>) =>
    [...slots].map((slot) => slotTitle(from.get(slot)!))
  return {
    changed: titles(
      [...now.keys()].filter(
        (slot) => old.has(slot) && content(old.get(slot)!) !== content(now.get(slot)!),
      ),
      now,
    ),
    added: titles(
      [...now.keys()].filter((slot) => !old.has(slot)),
      now,
    ),
    removed: titles(
      [...old.keys()].filter((slot) => !now.has(slot)),
      old,
    ),
  }
}

/**
 * Объект того же слота сохраняет свой номер: выделение, ссылки «Стойка № …» в замечаниях и
 * отметки проверки не сбиваются из-за одной перенумерации. Новые слоты получают новые номера
 * (`rebuildTemplatePlacements` выдаёт их не ниже `nextPlacementId`, совпадений нет).
 */
function keepSlotIds(before: readonly Placement[], after: readonly Placement[]): Placement[] {
  const ids = new Map(
    before
      .filter((placement) => placement.generatedByTemplate && placement.templateSlot)
      .map((placement) => [placement.templateSlot!, placement.id]),
  )
  return after.map((placement) => {
    const id =
      placement.generatedByTemplate && placement.templateSlot
        ? ids.get(placement.templateSlot)
        : undefined
    return id === undefined ? placement : { ...placement, id }
  })
}

/** Повторяющиеся названия считаются: «место работ ×4». */
function listed(titles: readonly string[]): string {
  const counts = new Map<string, number>()
  for (const title of titles) counts.set(title, (counts.get(title) ?? 0) + 1)
  return [...counts].map(([title, count]) => (count > 1 ? `${title} ×${count}` : title)).join(', ')
}

export function describeTemplateChanges(changes: TemplateChanges): string {
  const parts = [
    changes.changed.length ? `изменено ${changes.changed.length} (${listed(changes.changed)})` : '',
    changes.added.length ? `добавлено ${changes.added.length} (${listed(changes.added)})` : '',
    changes.removed.length ? `убрано ${changes.removed.length} (${listed(changes.removed)})` : '',
  ].filter(Boolean)
  return [
    parts.length
      ? `Типовые объекты перестроены по новым параметрам: ${parts.join('; ')}.`
      : 'Типовые объекты проверены по новым параметрам: изменений нет.',
    'Ручные объекты сохранены.',
    changes.keptSlots
      ? `Изменённых вручную объектов шаблона, оставленных без замены: ${changes.keptSlots} — проверьте, соответствуют ли они новым параметрам.`
      : '',
    changes.staleSlots
      ? `Изменённых вручную объектов прежней раскладки: ${changes.staleSlots} — новая раскладка их не заменяет, удалите лишние.`
      : '',
    parts.length
      ? 'Вернуть прежние параметры и объекты — «Отменить действие» в «Действия с проектом».'
      : '',
  ]
    .filter(Boolean)
    .join(' ')
}

export type AutoRebuild =
  /** Шаблон не собран или параметры раскладки не менялись. */
  | { kind: 'none' }
  | { kind: 'rebuilt'; scheme: Scheme; changes: TemplateChanges; message: string }
  /** Правка применена, а типовые объекты остались прежними: шаблон по новым данным не собрать. */
  | { kind: 'failed'; message: string }

export function autoRebuildTemplate(
  previous: Scheme,
  next: Scheme,
  rules: NormativeRules,
): AutoRebuild {
  if (!next.placements.some((placement) => placement.generatedByTemplate || placement.templateSlot))
    return { kind: 'none' }
  if (!templateInputsChanged(previous, next)) return { kind: 'none' }
  try {
    const rebuilt = rebuildTemplatePlacements(next, rules)
    const placements = keepSlotIds(next.placements, rebuilt.scheme.placements)
    const changes: TemplateChanges = {
      ...diff(next.placements, placements),
      keptSlots: rebuilt.keptSlots,
      staleSlots: rebuilt.staleSlots,
    }
    const objectsChanged = Boolean(
      changes.changed.length || changes.added.length || changes.removed.length,
    )
    if (!objectsChanged && !changes.keptSlots && !changes.staleSlots) return { kind: 'none' }
    // Повторная проверка схемы: номера объектов остаются уникальными.
    // Если нужны только предупреждения о ручных правках, объекты и счётчик номеров прежние.
    const scheme = objectsChanged ? schemeSchema.parse({ ...rebuilt.scheme, placements }) : next
    return { kind: 'rebuilt', scheme, changes, message: describeTemplateChanges(changes) }
  } catch (cause) {
    if (!(cause instanceof TemplateBuildError)) throw cause
    return {
      kind: 'failed',
      message: `Правки применены, но типовые объекты не перестроены и остались прежними: ${cause.message} После исправления соберите шаблон на этапе 3.`,
    }
  }
}
