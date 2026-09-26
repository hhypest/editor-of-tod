import { z } from 'zod'

const text = z.string().max(5_000)
const finite = z.number().finite()
const anchor = z.enum(['abs', 'L0', 'L1', 'Z0', 'Z1', 'E', 'AX'])
const distanceInput = z.union([finite, z.string().max(64)])
const auto = z.union([z.literal(0), z.literal(1)]).optional()

const workZone = z.object({
  taper: finite.positive(),
  buffer: finite.positive(),
  zone: finite.positive(),
  lTaper: text,
  lBuffer: text,
  lZone: text,
})

const signPost = z.object({
  t: z.literal('post'),
  id: z.number().int().positive(),
  signs: z.array(z.string().min(1).max(120)).min(1).max(20),
  anchor,
  dx: finite,
  dy: finite.optional(),
  side: z.enum(['up', 'down']),
  stand: z.enum(['left', 'right']),
  dist: text.nullable(),
  auto,
})

const element = z.object({
  t: z.literal('el'),
  id: z.number().int().positive(),
  e: z.enum(['reg', 'cone', 'car', 'complex', 'pit', 'text']),
  anchor,
  dx: finite,
  y: finite,
  w: finite.nonnegative(),
  h: finite.nonnegative(),
  text: text.optional(),
  size: finite.positive().optional(),
  bold: z.boolean().optional(),
  auto,
})

export const legacyV1Schema = z.object({
  v: z.literal(1),
  params: z.object({
    key: z.string().min(1).max(120),
    variant: z.enum(['b33', 'b34']),
    peregon: text,
    dirL: text,
    dirR: text,
    d300: distanceInput,
    d250: distanceInput,
    d150: distanceInput,
    d50: distanceInput,
    s1: finite.positive(),
    s2: finite.positive(),
    s3: finite.positive(),
    yellow: z.boolean(),
    len: z.object({ b33: workZone, b34: workZone }),
  }),
  head: z.object({
    dev_org: text,
    dev_fio: text,
    dev_date: text,
    org: text,
    work: text,
    term: text,
    resp1: text,
    resp2: text,
    ap_pos: text,
    ap_org: text,
    ap_fio: text,
    ag_pos: text,
    ag_fio: text,
    year: text,
  }),
  objects: z.array(z.discriminatedUnion('t', [signPost, element])).max(2_000),
  nid: z.number().int().positive(),
})

export type LegacyV1 = z.infer<typeof legacyV1Schema>
