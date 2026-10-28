import raw from '../../../tests/fixtures/frozen/projects/project-v10-native-b34.json?raw'
import { describe, expect, it } from 'vitest'
import { schemeV10Schema, upgradeSchemeV10, schemeSchema } from '../model'
import { importSchemeJson, exportSchemeJson } from '../import'
import { pu66SchemeRecordSchema } from '../pu66-snapshot'
import { linkPu66Card } from '../link-pu66'
import { pu66DisplayRows, pu66SheetNotes } from '../pu66-sheet-fields'
import { projectDraftSheet } from '../draft-sheet'
import { drawSheet } from '../sheet-drawing'

const original = JSON.parse(raw)
const card = pu66SchemeRecordSchema.parse({
  referenceId: 'DEMO-ONLY-900',
  location: '17 км 4 пк',
  axisLabel: '17 км 4 пк',
  roadName: 'Учебная дорога Омега',
  crossingWidthMetres: '7,2',
  crossingRoadLengthMetres: 19,
  railwayLocation: { section: 'Учебный перегон Альфа — Бета', station: 'Учебная станция Гамма' },
  visibility: {
    train: { rightOdd: 101, rightEven: 202, leftOdd: '303,5', leftEven: null },
    years: { previous: '2029', current: '2030' },
    technical: [
      {
        item: '12',
        label: 'Видимость встречного автомобиля с востока, м',
        previous: 110,
        current: 220,
      },
      {
        item: '12',
        label: 'Видимость встречного автомобиля с запада, м',
        previous: null,
        current: 'не измерена',
      },
    ],
  },
  revision: 1,
  updatedAt: '2030-02-01T00:00:00.000Z',
})

describe('versioned PU-66 sheet snapshot (#110)', () => {
  it('migrates the v10 envelope without extending or rewriting the saved snapshot and marks', () => {
    const previous = schemeV10Schema.parse(original)
    const migrated = upgradeSchemeV10(original)
    expect(migrated).toEqual({ ...previous, schemaVersion: 11 })
    expect(migrated.crossing.snapshot).not.toHaveProperty('visibility')
    expect(migrated.crossing.snapshot).not.toHaveProperty('railwayLocation')
    expect(importSchemeJson(JSON.stringify(original))).toMatchObject({
      format: 'scheme-v10',
      scheme: migrated,
    })
    expect(
      schemeV10Schema.safeParse({
        ...original,
        crossing: {
          ...original.crossing,
          snapshot: { ...original.crossing.snapshot, visibility: card.visibility },
        },
      }).success,
    ).toBe(false)
  })

  it('copies the approved data by explicit linking and round-trips them without adding a registry card', () => {
    const scheme = upgradeSchemeV10(original)
    const selected = structuredClone(card)
    const linked = linkPu66Card(scheme, selected)
    const snapshot = structuredClone(linked.crossing.snapshot)
    selected.visibility!.train.rightOdd = 999
    expect(linked.crossing.snapshot).toEqual(snapshot)
    expect(scheme.crossing).toEqual(original.crossing)
    expect(importSchemeJson(exportSchemeJson(linked))).toMatchObject({
      format: 'scheme-v11',
      scheme: linked,
    })
    expect(
      schemeSchema.safeParse({
        ...linked,
        crossing: { ...linked.crossing, snapshot: { ...snapshot, personnel: 'PRIVATE' } },
      }).success,
    ).toBe(false)
  })

  it('prints pinned directions, source years and objects, without a live registry dependency', () => {
    const linked = linkPu66Card(upgradeSchemeV10(original), card)
    const projection = projectDraftSheet(linked)
    expect(projection.crossingFromPu66?.railwayLocation).toEqual(card.railwayLocation)
    const notes = pu66SheetNotes(linked.crossing.snapshot).join('\n')
    expect(notes).toContain('справа — нечётного направления')
    expect(notes).toContain('чётного 202')
    expect(notes).toContain('2029 / 2030')
    expect(notes).toContain('Видимость встречного автомобиля с востока, м: 110 / 220')
    expect(notes).toContain('с запада, м: — / не измерена')
    expect(pu66DisplayRows(linked.crossing.snapshot)).toHaveLength(8)
    expect(projection.pu66Notes).toEqual(pu66SheetNotes(linked.crossing.snapshot))
    expect(
      drawSheet(projection, { signSizes: new Map(), catalogLabel: 'Учебный', revisionLabel: '' })
        .overflow,
    ).not.toContain('Примечание')
  })

  it('reports overflow instead of silently approving a sheet whose complete visibility cannot fit', () => {
    const selected = structuredClone(card)
    selected.visibility!.technical = Array.from({ length: 100 }, (_, index) => ({
      item: '12',
      label: `Учебное направление ${index}`,
      previous: 101,
      current: 202,
    }))
    const linked = linkPu66Card(upgradeSchemeV10(original), selected)
    expect(
      drawSheet(projectDraftSheet(linked), {
        signSizes: new Map(),
        catalogLabel: 'Учебный',
        revisionLabel: '',
      }).overflow,
    ).toContain('Примечание')
  })
})
