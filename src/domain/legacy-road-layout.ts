import { z } from 'zod'
import type { LegacyV1 } from './legacy-v1'

const finite = z.number().finite()
const id = finite.int().positive()
const text = z.string().max(5_000)
const bit = z.union([z.literal(0), z.literal(1), z.boolean()])

/** Extra producer fields are validated outside the frozen v1 reader. No geometry is inferred. */
export const legacyRoadFieldsSchema = z
  .looseObject({
    params: z.looseObject({
      junc: z
        .array(
          z.looseObject({
            id,
            app: z.enum(['L', 'R']),
            edge: z.enum(['up', 'down']),
            d: finite.nonnegative(),
            kind: z.enum(['road', 'yard']),
            name: text,
            side: z.boolean(),
            px: finite.optional(),
          }),
        )
        .max(2_000)
        .optional(),
      tee: z
        .discriminatedUnion('on', [
          z.looseObject({ on: z.literal(false) }),
          z.looseObject({
            on: z.literal(true),
            app: z.enum(['L', 'R']),
            d: finite.nonnegative(),
            n1: text,
            n2: text,
            px: finite.optional(),
          }),
        ])
        .optional(),
    }),
    objects: z.array(
      z.looseObject({
        jrep: id.optional(),
        jside: id.optional(),
        tee: bit.optional(),
        vert: bit.optional(),
        sc: finite.positive().optional(),
      }),
    ),
  })
  .superRefine((value, context) => {
    const ids = new Set<number>()
    for (const [index, node] of (value.params.junc ?? []).entries()) {
      if (ids.has(node.id))
        context.addIssue({
          code: 'custom',
          path: ['params', 'junc', index, 'id'],
          message: 'Повторяющийся идентификатор примыкания',
        })
      ids.add(node.id)
    }
  })

/** Preserve junction-related posts and elements as manual until P6 can own their relations. */
export function isLegacyRoadObject(object: LegacyV1['objects'][number]): boolean {
  return (
    object.jrep !== undefined ||
    object.jside !== undefined ||
    object.tee === 1 ||
    object.tee === true ||
    object.vert === 1 ||
    object.vert === true
  )
}

/** The suffix is a plate value, never a new catalog sign. Unsupported spellings stay intact. */
export function legacyPlateCode(code: string): string {
  return code.replace(/^(8\.1\.[134])#(\d+)$/, '$1_$2')
}

export const LEGACY_ROAD_LAYOUT_PROBLEM =
  'В исходном файле есть примыкания, Т-перекрёсток или связанные объекты. Их геометрия ещё не поддерживается: автоматическая перестройка и выпуск этого проекта недоступны. Объекты и исходный файл сохранены; используйте черновик для сверки.'

type LegacySource = { kind: string; originalJson?: string }
const cache = new WeakMap<object, { json: string; active: boolean }>()

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function hasRoadLayout(json: string): boolean {
  let value: unknown
  try {
    value = JSON.parse(json)
  } catch {
    return false
  }
  const root = record(value)
  if (root?.v !== 1) return false
  const params = record(root.params)
  // Malformed nonempty extensions in previously saved projects are not safe to rebuild either.
  if (params?.junc !== undefined && (!Array.isArray(params.junc) || params.junc.length > 0))
    return true
  if (params?.tee !== undefined && record(params.tee)?.on !== false) return true
  return (
    Array.isArray(root.objects) &&
    root.objects.some((value) => {
      const object = record(value)
      return (
        object !== null &&
        (object.jrep !== undefined ||
          object.jside !== undefined ||
          object.tee === 1 ||
          object.tee === true ||
          object.vert === 1 ||
          object.vert === true)
      )
    })
  )
}

/** Works after save/open and for v11 imports made before the preservation fix, without migration. */
export function legacyRoadLayoutProblem(source: LegacySource): string | null {
  if (source.kind !== 'legacy-html-v1' || !source.originalJson) return null
  const previous = cache.get(source)
  const active =
    previous?.json === source.originalJson ? previous.active : hasRoadLayout(source.originalJson)
  if (previous?.json !== source.originalJson)
    cache.set(source, { json: source.originalJson, active })
  return active ? LEGACY_ROAD_LAYOUT_PROBLEM : null
}
