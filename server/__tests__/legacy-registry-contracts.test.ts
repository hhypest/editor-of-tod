import { openTestApplication } from './test-application'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'

import type { CrossingDraft, NormativeDraft } from '../../src/domain/registry'

const crossing: CrossingDraft = {
  referenceId: 'test-legacy',
  railwayLocation: 'Учебный участок',
  roadName: '',
  roadOwner: '',
  cardReference: '',
  cardUpdatedAt: '',
  verifiedAt: '',
  notes: 'Вымышленная запись',
}
const normative: NormativeDraft = {
  id: 'test-legacy',
  documentCode: 'УЧЕБНЫЙ',
  edition: '2030',
  clause: 'Учебный пункт',
  description: 'Вымышленный источник',
  application: '',
  sourceUrl: '',
  reviewStatus: 'needs-review',
  checkedAt: '',
  reviewer: '',
}

/** These contracts first run against the unchanged RegistryStore. */
describe('legacy registry contracts through initialized owners', () => {
  it('keeps seed/clock policy and does not fill missing defaults in an existing nonempty registry', () => {
    const directory = mkdtempSync(join(tmpdir(), 'tod-legacy-seed-'))
    const path = join(directory, 'registry.sqlite')
    let calls = 0
    const clockContext = { path: path }
    function clock(this: typeof clockContext) {
      expect(this).toBe(clockContext)
      expect(this.path).toBe(path)
      calls++
      return '2030-01-01T00:00:00.000Z'
    }
    const store = openTestApplication(path, clock.bind(clockContext))
    try {
      expect(calls).toBe(4)
      expect(store.legacy.listNormative().map((row) => row.id)).toEqual([
        'gost-r-52289-2019',
        'gost-r-52290-2024',
        'odm-218-6-019-2016-b33',
        'odm-218-6-019-2016-b34',
      ])
      expect(
        store.legacy
          .listNormative()
          .every(
            (row) =>
              row.revision === 1 &&
              row.reviewStatus === 'needs-review' &&
              row.reviewer === '' &&
              row.checkedAt === '',
          ),
      ).toBe(true)
      store.legacy.saveCrossing(crossing, 0)
      store.legacy.saveNormative(normative, 0)
      expect(calls).toBe(6)
    } finally {
      store.runtime.close()
    }
    const raw = new DatabaseSync(path)
    try {
      raw.prepare('DELETE FROM normative WHERE key <> ?').run(normative.id)
    } finally {
      raw.close()
    }
    const reopened = openTestApplication(path, clock.bind(clockContext))
    try {
      expect(calls).toBe(6)
      expect(reopened.legacy.listNormative()).toEqual([
        { ...normative, revision: 1, updatedAt: '2030-01-01T00:00:00.000Z' },
      ])
      expect(reopened.legacy.history('normative', 'odm-218-6-019-2016-b33')).toHaveLength(1)
      expect(reopened.legacy.saveNormative(normative, 1).revision).toBe(2)
      expect(calls).toBe(7)
    } finally {
      reopened.runtime.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it.each(['crossings', 'normative'] as const)(
    'rolls back current %s and history when appending a revision fails',
    (kind) => {
      const directory = mkdtempSync(join(tmpdir(), 'tod-legacy-history-failure-'))
      const path = join(directory, 'registry.sqlite')
      const store = openTestApplication(path)
      const raw = new DatabaseSync(path)
      const save =
        kind === 'crossings'
          ? (version: number) =>
              store.legacy.saveCrossing(
                { ...crossing, notes: `Учебная правка ${version}` },
                version,
              )
          : (version: number) =>
              store.legacy.saveNormative(
                { ...normative, description: `Учебная правка ${version}` },
                version,
              )
      try {
        save(0)
        const before = raw.prepare(`SELECT * FROM ${kind} WHERE key = ?`).get('test-legacy')
        const history = store.legacy.history(kind, 'test-legacy')
        raw.exec(`CREATE TRIGGER reject_legacy_history AFTER INSERT ON revisions
        WHEN NEW.key = 'test-legacy' AND NEW.revision = 2
        BEGIN SELECT RAISE(ABORT, 'synthetic history failure'); END`)
        expect(() => save(1)).toThrow('synthetic history failure')
        expect(raw.prepare(`SELECT * FROM ${kind} WHERE key = ?`).get('test-legacy')).toEqual(
          before,
        )
        expect(store.legacy.history(kind, 'test-legacy')).toEqual(history)
        raw.exec('DROP TRIGGER reject_legacy_history')
        expect(save(1).revision).toBe(2)
        expect(store.legacy.history(kind, 'test-legacy').map((row) => row.revision)).toEqual([1, 2])
      } finally {
        raw.close()
        store.runtime.close()
        rmSync(directory, { recursive: true, force: true })
      }
    },
  )
})
