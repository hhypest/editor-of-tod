import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import {
  schemeV2Schema,
  schemeV3Schema,
  schemeV4Schema,
  schemeV5Schema,
  schemeV6Schema,
  schemeV7Schema,
  schemeV8Schema,
  schemeV9Schema,
} from '../../src/domain/formats/frozen/project-v2-v9'
import { schemeV10Schema } from '../../src/domain/formats/frozen/project-v10'

// A live schema must never be loaded while reading a historical document.
vi.mock('../../src/domain/model', () => {
  throw new Error('live model loaded')
})
vi.mock('../../src/domain/pu66-snapshot', () => {
  throw new Error('live snapshot loaded')
})
vi.mock('../../src/domain/decision-evidence-schema', () => {
  throw new Error('live evidence loaded')
})
vi.mock('../../src/domain/title-block', () => {
  throw new Error('live title-block loaded')
})
vi.mock('../../src/domain/post-distance', () => {
  throw new Error('live post-distance loaded')
})

const readers = {
  2: schemeV2Schema,
  3: schemeV3Schema,
  4: schemeV4Schema,
  5: schemeV5Schema,
  6: schemeV6Schema,
  7: schemeV7Schema,
  8: schemeV8Schema,
  9: schemeV9Schema,
  10: schemeV10Schema,
}
const root = fileURLToPath(new URL('../../tests/fixtures/frozen/projects/', import.meta.url))
const read = (name: string) => JSON.parse(readFileSync(`${root}/${name}`, 'utf8'))

describe('independent historical readers (#137)', () => {
  it.each(readdirSync(root).filter((name) => /-v(?:[2-9]|10)-/.test(name)))(
    'reads %s without live validators',
    (name) => {
      const original = read(name)
      const reader = readers[original.schemaVersion as keyof typeof readers]
      expect(reader.parse(original)).toMatchObject(original)
      expect(reader.safeParse({ ...original, futureField: true }).success).toBe(false)
      expect(reader.safeParse({ ...original, nextPlacementId: 1 }).success).toBe(false)
    },
  )

  it('does not accept fields added by later project versions, including nested snapshots', () => {
    const v7 = read('project-v7-native-b33.json')
    v7.parameters.workConditions = { kind: 'short' }
    expect(schemeV7Schema.safeParse(v7).success).toBe(false)
    const v8 = read('project-v8-native-b33.json')
    v8.parameters.speedConditions = { road: 'ordinary', vehicle: 'light' }
    expect(schemeV8Schema.safeParse(v8).success).toBe(false)
    const v9 = read('project-v9-imported-b34.json')
    v9.placements.find((p: { kind: string }) => p.kind === 'sign-post').distance = null
    expect(schemeV9Schema.safeParse(v9).success).toBe(false)
    const v4 = read('project-v4-native-b33.json')
    v4.crossing.snapshot.futureVisibility = 500
    expect(schemeV4Schema.safeParse(v4).success).toBe(false)
  })
})
