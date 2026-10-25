import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { RegistryStore, AmbiguousPu66Key } from '../store'
import { readCard, readEntry, PRIVATE_MARKER } from './pu66-read-fixture'

/** Run these contracts on the original facade before moving read SQL and key resolution. */
describe('PU-66 read contracts through RegistryStore', () => {
  it('preserves current-key priority, alias errors and the separate scheme/norms whitelists', () => {
    const directory = mkdtempSync(join(tmpdir(), 'tod-pu66-read-contract-'))
    const path = join(directory, 'registry.sqlite')
    const store = new RegistryStore(path, () => '2030-02-01T00:00:00.000Z'),
      raw = new DatabaseSync(path)
    const card = readCard()
    try {
      store.importPu66([readEntry(card)])
      const insert = raw.prepare('INSERT INTO pu66_key_aliases VALUES (?, ?)')
      insert.run('old-single', card.key)
      insert.run('old-ambiguous', null)
      insert.run(card.key, null)
      expect(store.getPu66Scheme('old-single')).toEqual({
        referenceId: card.key,
        location: '88 км 3 пк',
        axisLabel: '88 км 3 пк',
        roadName: 'Вымышленная дорога',
        crossingWidthMetres: 8,
        crossingRoadLengthMetres: 9,
        revision: 1,
        updatedAt: '2030-02-01T00:00:00.000Z',
      })
      expect(store.getPu66Scheme(card.key)).toEqual(store.getPu66Scheme('old-single'))
      const norms = store.getPu66Norms('old-single')!
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
      expect(norms.trainVisibilityMetres).toEqual(card.trainVisibilityMetres)
      expect(norms.technicalRows[0]).not.toHaveProperty('row')
      expect(
        JSON.stringify([store.getPu66Scheme(card.key), norms, store.listPu66()]),
      ).not.toContain(PRIVATE_MARKER)
      store.recordPu66Verification('old-single', {
        expectedRevision: 1,
        verifiedAt: '2030-01-30',
        verifiedBy: 'Учебный специалист',
      })
      expect(store.listPu66Verifications('old-single')).toHaveLength(1)
      expect(store.getPu66Status('old-single')?.referenceId).toBe(card.key)
      expect(store.getPu66Scheme('missing')).toBeNull()
      for (const read of [
        () => store.getPu66Scheme('old-ambiguous'),
        () => store.getPu66Norms('old-ambiguous'),
        () => store.getPu66Status('old-ambiguous'),
        () => store.listPu66Verifications('old-ambiguous'),
      ])
        expect(read).toThrow(AmbiguousPu66Key)
    } finally {
      raw.close()
      store.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('shows only the latest verification of the current revision and retains exclusion filtering', () => {
    const directory = mkdtempSync(join(tmpdir(), 'tod-pu66-read-list-contract-'))
    const path = join(directory, 'registry.sqlite')
    const store = new RegistryStore(path, () => '2030-02-01T00:00:00.000Z'),
      raw = new DatabaseSync(path)
    const card = readCard()
    try {
      store.importPu66([readEntry(card)])
      for (const [verifiedAt, verifiedBy] of [
        ['2030-01-30', 'Учебный А'],
        ['2030-01-20', 'Учебный Б'],
        ['2030-01-30', 'Учебный В'],
      ])
        store.recordPu66Verification(card.key, {
          expectedRevision: 1,
          verifiedAt: verifiedAt!,
          verifiedBy: verifiedBy!,
        })
      expect(store.listPu66()[0]?.verification).toMatchObject({
        cardRevision: 1,
        verifiedAt: '2030-01-30',
        verifiedBy: 'Учебный В',
      })
      store.importPu66([readEntry(card, 'changed')])
      expect(store.listPu66()[0]).toMatchObject({ revision: 2, verification: null })
      expect(store.listPu66Verifications(card.key)).toHaveLength(3)
      raw
        .prepare(
          `INSERT INTO pu66_lifecycle (key, card_revision, action, date, actor, reason, comment, recorded_at) VALUES (?, 2, 'exclude', '2030-02-01', 'Учебный', 'reassigned', 'Вымышленное исключение', '2030-02-01T00:00:00.000Z')`,
        )
        .run(card.key)
      expect(store.listPu66()).toEqual([])
      expect(store.listPu66(true)).toHaveLength(1)
      expect(store.getPu66Scheme(card.key)?.revision).toBe(2)
    } finally {
      raw.close()
      store.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
