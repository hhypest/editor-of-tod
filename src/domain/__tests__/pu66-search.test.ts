import { describe, expect, it } from 'vitest'
import { searchPu66Cards } from '../pu66-search'

const cards = [
  {
    referenceId: '90001:12:3',
    location: '12 км 3 пк',
    roadName: 'Учебная дорога А',
    section: 'Учебный участок Север (90001)',
    station: 'Условная станция Север',
  },
  {
    referenceId: '90002:24:7',
    location: '24 км 7 пк',
    roadName: 'Учебная дорога Б',
    section: 'Учебный участок Юг (90002)',
    station: '',
  },
  {
    referenceId: 'ст.Условная станция Озёрная:53:2:к905',
    location: '53 км 2 пк',
    roadName: 'Учебный станционный проезд',
    section: '',
    station: 'Условная станция Озёрная',
  },
  {
    referenceId: '90003:2:12',
    location: '2 км 12 пк',
    roadName: 'Учебная дорога В',
    section: 'Учебный участок Запад (90003)',
    station: '',
  },
]

const ids = (query: string) => searchPu66Cards(cards, query).map((card) => card.referenceId)

describe('PU-66 card search', () => {
  it('returns every card for an empty query', () => {
    expect(ids('  ')).toHaveLength(4)
  })

  it('finds a crossing by kilometre and picket written in different ways', () => {
    expect(ids('24 км 7 пк')).toEqual(['90002:24:7'])
    expect(ids('24/7')).toEqual(['90002:24:7'])
    expect(ids('53:2')).toEqual(['ст.Условная станция Озёрная:53:2:к905'])
  })

  it('returns the card whose key is typed in full', () => {
    expect(ids(' 90002:24:7 ')).toEqual(['90002:24:7'])
    expect(ids('ст.условная станция озерная:53:2:к905')).toHaveLength(1)
  })

  it('compares marked kilometre and picket only with the crossing place', () => {
    expect(ids('2 км')).toEqual(['90003:2:12'])
    expect(ids('2 пк')).toEqual(['ст.Условная станция Озёрная:53:2:к905'])
    expect(ids('12км 3пк')).toEqual(['90001:12:3'])
  })

  it('ranks whole numbers above prefixes for unmarked numbers', () => {
    const found = ids('2')
    expect(found.at(-1)).toBe('90002:24:7')
    expect(found).not.toContain('90001:12:3')
  })

  it('searches station, section and road case-insensitively and treats ё as е', () => {
    expect(ids('озерная')).toEqual(['ст.Условная станция Озёрная:53:2:к905'])
    expect(ids('ст. Озёрная')).toEqual(['ст.Условная станция Озёрная:53:2:к905'])
    expect(ids('участок юг')).toEqual(['90002:24:7'])
    expect(ids('дорога а')).toEqual(['90001:12:3'])
  })

  it('requires every word to match', () => {
    expect(ids('Север 24')).toEqual([])
    expect(ids('несуществующая')).toEqual([])
  })
})
