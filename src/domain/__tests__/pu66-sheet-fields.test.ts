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
    expect(migrated).toEqual({
      ...previous,
      schemaVersion: 17,
      roadLayout: { nextNodeId: 1, nodes: [], links: [] },
    })
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
      format: 'scheme-v17',
      scheme: linked,
    })
    expect(
      schemeSchema.safeParse({
        ...linked,
        crossing: { ...linked.crossing, snapshot: { ...snapshot, personnel: 'PRIVATE' } },
      }).success,
    ).toBe(false)
  })

  it('prints only pinned train directions and retains technical years and objects in the card', () => {
    const linked = linkPu66Card(upgradeSchemeV10(original), card)
    const projection = projectDraftSheet(linked)
    expect(projection.crossingFromPu66?.railwayLocation).toEqual(card.railwayLocation)
    const notes = pu66SheetNotes(linked.crossing.snapshot).join('\n')
    expect(notes).toContain('справа — нечётного направления')
    expect(notes).toContain('чётного 202')
    expect(pu66SheetNotes(linked.crossing.snapshot)).toHaveLength(1)
    expect(notes).not.toContain('2029 / 2030')
    expect(notes).not.toContain('Видимость встречного автомобиля')
    expect(pu66DisplayRows(linked.crossing.snapshot)).toContainEqual({
      label: 'ПУ-66, п. 12: Видимость встречного автомобиля с востока, м',
      value: '2029: 110; 2030: 220',
    })
    expect(pu66DisplayRows(linked.crossing.snapshot)).toHaveLength(8)
    expect(projection.pu66Notes).toEqual(pu66SheetNotes(linked.crossing.snapshot))
    expect(
      drawSheet(projection, { signSizes: new Map(), catalogLabel: 'Учебный', revisionLabel: '' })
        .overflow,
    ).not.toContain('Примечание')
  })

  it('keeps extensive technical data in the project without copying them into sheet notes', () => {
    const selected = structuredClone(card)
    selected.visibility!.technical = Array.from({ length: 100 }, (_, index) => ({
      item: '12',
      label: `Учебное направление ${index}`,
      previous: 101,
      current: 202,
    }))
    const linked = linkPu66Card(upgradeSchemeV10(original), selected)
    expect(importSchemeJson(exportSchemeJson(linked)).scheme.crossing.snapshot).toEqual(
      linked.crossing.snapshot,
    )
    expect(pu66DisplayRows(linked.crossing.snapshot)).toHaveLength(106)
    expect(pu66SheetNotes(linked.crossing.snapshot)).toHaveLength(1)
    expect(
      drawSheet(projectDraftSheet(linked), {
        signSizes: new Map(),
        catalogLabel: 'Учебный',
        revisionLabel: '',
      }).overflow,
    ).not.toContain('Примечание')
  })

  it('does not replace unknown train visibility with technical-table data or drop an explicit zero', () => {
    const selected = structuredClone(card)
    selected.visibility!.train = { rightOdd: null, rightEven: null, leftOdd: null, leftEven: null }
    expect(pu66SheetNotes(selected)).toEqual([])
    expect(pu66DisplayRows(selected)).toHaveLength(8)
    selected.visibility!.train.rightOdd = 0
    expect(pu66SheetNotes(selected)).toEqual([
      'Видимость поезда, м (ПУ-66): справа — нечётного направления 0, чётного —; слева — нечётного —, чётного —.',
    ])
  })

  it('still reports note overflow for an overlong retained train-visibility summary', () => {
    const selected = structuredClone(card)
    selected.visibility!.train.rightOdd = 'Учебное длинное значение '.repeat(70)
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
