import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../database/connection'
import { migrateDatabase } from '../database/migration-runner'
import { Pu66Repository } from '../pu66/repository'
import { Pu66KeyResolver } from '../pu66/key-resolver'
import { AmbiguousPu66Key } from '../pu66/errors'

import { readCard, seedReadCard, PRIVATE_MARKER } from './pu66-read-fixture'

const connections: DatabaseSync[] = [],
  directories: string[] = []
afterEach(() => {
  for (const db of connections.splice(0)) db.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})
function setup(path = ':memory:') {
  const db = openDatabase(path)
  connections.push(db)
  migrateDatabase(db, { path, now: () => '2030-02-01T00:00:00.000Z' })
  const keys = new Pu66KeyResolver(db)
  return { db, keys, cards: new Pu66Repository(db, keys) }
}

describe('PU-66 read repository and key resolver without RegistryStore', () => {
  it('reads missing state on a read-only connection without seeding data', () => {
    const { db, keys, cards } = setup()
    db.exec('PRAGMA query_only = ON')
    expect(keys.resolve('missing')).toBeNull()
    expect(cards.list()).toEqual([])
    expect(cards.list(true)).toEqual([])
    expect(cards.getScheme('missing')).toBeNull()
    expect(cards.getNorms('missing')).toBeNull()
    expect(db.prepare('SELECT COUNT(*) AS count FROM normative').get()).toEqual({ count: 0 })
  })

  it('prioritizes current keys and preserves single-hop, ambiguous and dangling aliases', () => {
    const { db, keys, cards } = setup(),
      card = readCard()
    seedReadCard(db, card)
    const insert = db.prepare('INSERT INTO pu66_key_aliases VALUES (?, ?)')
    insert.run(card.key, null)
    insert.run('old-single', card.key)
    insert.run('old-ambiguous', null)
    insert.run('dangling', 'missing-target')
    insert.run('chain', 'old-single')
    db.exec('PRAGMA query_only = ON')

    expect(keys.resolve(card.key)).toBe(card.key)
    expect(keys.resolve('old-single')).toBe(card.key)
    expect(cards.getScheme('old-single')).toEqual(cards.getScheme(card.key))
    expect(cards.getNorms('old-single')).toEqual(cards.getNorms(card.key))
    expect(() => keys.resolve('old-ambiguous')).toThrow(AmbiguousPu66Key)
    expect(() => cards.getNorms('old-ambiguous')).toThrow('на станции несколько карточек')
    // Resolve only the recorded mapping, as before; do not invent transitive links/repairs.
    expect(keys.resolve('chain')).toBe('old-single')
    expect(keys.resolve('dangling')).toBe('missing-target')
    expect(cards.getScheme('chain')).toBeNull()
    expect(cards.getNorms('dangling')).toBeNull()
  })

  it('keeps the exact scheme/norms projections and raw cell types without leaking source/personnel', () => {
    const { db, cards } = setup(),
      card = readCard()
    card.roadName = '0'
    card.technicalRows.find((row) => row.item === '7')!.current = '7,5'
    card.technicalRows.find((row) => row.item === '8')!.current = 0
    seedReadCard(db, card)
    db.exec('PRAGMA query_only = ON')
    expect(cards.getScheme(card.key)).toEqual({
      referenceId: card.key,
      location: '88 км 3 пк',
      axisLabel: '88 км 3 пк',
      roadName: '',
      crossingWidthMetres: '7,5',
      crossingRoadLengthMetres: 0,
      railwayLocation: { section: card.section, station: card.station },
      visibility: { train: card.trainVisibilityMetres, years: card.years, technical: [] },
      revision: 1,
      updatedAt: '2030-02-01T00:00:00.000Z',
    })
    const norms = cards.getNorms(card.key)!
    expect(Object.keys(norms).sort()).toEqual(
      [
        'referenceId',
        'roadCategory',
        'carCountPerDay',
        'trainCountPerDay',
        'trainVisibilityMetres',
        'years',
        'technicalRows',
        'revision',
        'updatedAt',
      ].sort(),
    )
    expect(norms).toMatchObject({
      roadCategory: 'II',
      carCountPerDay: 800,
      trainCountPerDay: 40,
      trainVisibilityMetres: { rightOdd: 101, rightEven: 102, leftOdd: 103, leftEven: 104 },
      years: { previous: '2029', current: '2030' },
    })
    expect(norms.technicalRows[0]).toEqual({
      item: '1',
      label: 'Учебное поле 1',
      statedNorm: 'Вымышленное основание',
      previous: 1,
      current: 2,
    })
    expect(JSON.stringify([cards.list(), cards.getScheme(card.key), norms])).not.toContain(
      PRIVATE_MARKER,
    )
    expect(norms).not.toHaveProperty('workbook')
    expect(cards.getScheme(card.key)).not.toHaveProperty('carCountPerDay')
  })

  it('selects verification only for the current revision, by date and then id', () => {
    const { db, cards } = setup(),
      card = readCard()
    seedReadCard(db, card, 1)
    seedReadCard(db, card, 2)
    const insert = db.prepare(
      'INSERT INTO pu66_verifications (key, card_revision, verified_at, verified_by, recorded_at) VALUES (?, ?, ?, ?, ?)',
    )
    insert.run(card.key, 1, '2030-02-01', 'Старая версия', '2030-02-01T00:00:00.000Z')
    insert.run(card.key, 2, '2030-01-30', 'Учебный А', '2030-02-01T00:00:01.000Z')
    insert.run(card.key, 2, '2030-01-20', 'Учебный Б', '2030-02-01T00:00:02.000Z')
    insert.run(card.key, 2, '2030-01-30', 'Учебный В', '2030-02-01T00:00:03.000Z')
    db.exec('PRAGMA query_only = ON')
    expect(cards.list()[0]?.verification).toEqual({
      cardRevision: 2,
      verifiedAt: '2030-01-30',
      verifiedBy: 'Учебный В',
      recordedAt: '2030-02-01T00:00:03.000Z',
    })
  })

  it('filters exclusion by the latest event id, while keeping direct snapshots and list ordering', () => {
    const { db, cards } = setup(),
      one = readCard('aaa'),
      two = readCard('bbb'),
      three = readCard('ccc')
    for (const card of [three, two, one]) seedReadCard(db, card)
    const event = db.prepare(
      `INSERT INTO pu66_lifecycle (key, card_revision, action, date, actor, reason, comment, recorded_at) VALUES (?, 1, ?, ?, 'Учебный', NULL, 'Вымышленное событие', '2030-02-01T00:00:00.000Z')`,
    )
    event.run(one.key, 'exclude', '2030-01-30')
    event.run(one.key, 'restore', '2030-01-01')
    event.run(two.key, 'exclude', '2030-01-30')
    db.exec('PRAGMA query_only = ON')
    expect(cards.list().map((row) => row.referenceId)).toEqual(['aaa', 'ccc'])
    expect(cards.list(true).map((row) => row.referenceId)).toEqual(['aaa', 'bbb', 'ccc'])
    expect(cards.getScheme(two.key)?.referenceId).toBe(two.key) // HTTP retains its separate lifecycle guard.
    expect(cards.list()[0]).toMatchObject({
      verification: null,
      section: one.section,
      station: one.station,
      carCountPerDay: 800,
    })
  })

  it('observes committed updates from another connection without rewriting old revisions or creating projects', () => {
    const directory = mkdtempSync(join(tmpdir(), 'tod-pu66-read-update-'))
    directories.push(directory)
    const path = join(directory, 'registry.sqlite'),
      reader = setup(path),
      writer = setup(path)
    const card = readCard()
    seedReadCard(writer.db, card, 1)
    const before = writer.db
      .prepare('SELECT payload_json FROM pu66_revisions WHERE revision = 1')
      .get()
    reader.db.exec('PRAGMA query_only = ON')
    expect(reader.cards.getScheme(card.key)?.revision).toBe(1)
    writer.db.exec('BEGIN IMMEDIATE')
    seedReadCard(writer.db, { ...card, roadName: 'Изменённая учебная дорога' }, 2)
    writer.db.exec('COMMIT')
    expect(reader.cards.getScheme(card.key)).toMatchObject({
      roadName: 'Изменённая учебная дорога',
      revision: 2,
    })
    expect(reader.cards.getNorms(card.key)?.revision).toBe(2)
    expect(reader.cards.list()[0]).toMatchObject({ revision: 2, verification: null })
    expect(
      reader.db.prepare('SELECT payload_json FROM pu66_revisions WHERE revision = 1').get(),
    ).toEqual(before)
    expect(reader.db.prepare('SELECT COUNT(*) AS count FROM project_drafts').get()).toEqual({
      count: 0,
    })
  })
})
