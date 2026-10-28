import { describe, expect, it } from 'vitest'
import { schemeFields } from '../pu66'
import { readCard, PRIVATE_MARKER } from './pu66-read-fixture'
import { pu66SchemeRecordSchema } from '../../src/domain/pu66-snapshot'

describe('approved scheme fields (#110), entirely fictional cards', () => {
  it('retains visibility objects, direction subrows, both years and raw values, excluding other data', () => {
    const card = readCard()
    card.station = 'Учебная станция Альфа'
    card.technicalRows = [
      {
        row: 60,
        item: '12',
        label: 'Видимость встречного автомобиля, м',
        statedNorm: PRIVATE_MARKER,
        previous: null,
        current: null,
      },
      { row: 61, item: '12', label: 'справа:', statedNorm: null, previous: null, current: null },
      {
        row: 62,
        item: '12',
        label: 'северное направление',
        statedNorm: PRIVATE_MARKER,
        previous: '111,5',
        current: 222,
      },
      { row: 63, item: '12', label: 'слева:', statedNorm: null, previous: null, current: null },
      {
        row: 64,
        item: '12',
        label: 'южное направление',
        statedNorm: null,
        previous: 0,
        current: 'нет сведений',
      },
      {
        row: 65,
        item: '13',
        label: PRIVATE_MARKER,
        statedNorm: null,
        previous: PRIVATE_MARKER,
        current: PRIVATE_MARKER,
      },
      {
        row: 66,
        item: '14',
        label: 'Видимость сигнала, м',
        statedNorm: null,
        previous: 333,
        current: 444,
      },
    ]
    const selected = schemeFields(card)
    const record = pu66SchemeRecordSchema.parse({
      ...selected,
      revision: 1,
      updatedAt: '2030-02-01T00:00:00.000Z',
    })
    expect(record.railwayLocation).toEqual({ section: card.section, station: card.station })
    expect(record.visibility?.train).toEqual(card.trainVisibilityMetres)
    expect(record.visibility?.years).toEqual(card.years)
    expect(record.visibility?.technical).toEqual(
      card.technicalRows
        .filter((row) => row.item !== '13')
        .map(({ item, label, previous, current }) => ({ item, label, previous, current })),
    )
    expect(JSON.stringify(selected)).not.toContain(PRIVATE_MARKER)
    for (const field of [
      'technicalRows',
      'carCountPerDay',
      'attendant',
      'division',
      'crossingOwner',
    ])
      expect(record).not.toHaveProperty(field)
  })
})
