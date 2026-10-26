import { openTestApplication } from './test-application'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { InvalidPu66Lifecycle } from '../pu66/errors'
import { readCard, readEntry } from './pu66-read-fixture'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})
function setup(clock: () => string = () => '2030-02-01T00:00:00.000Z') {
  const directory = mkdtempSync(join(tmpdir(), 'tod-import-contract-')),
    path = join(directory, 'registry.sqlite'),
    store = openTestApplication(path, clock),
    raw = new DatabaseSync(path),
    entries = [readEntry(readCard('99999:88:3')), readEntry(readCard('99999:89:4'))]
  cleanups.push(() => {
    raw.close()
    store.runtime.close()
    rmSync(directory, { recursive: true, force: true })
  })
  return { store, raw, entries }
}
function snapshot(db: DatabaseSync) {
  return ['pu66_sources', 'pu66_cards', 'pu66_revisions', 'pu66_lifecycle'].map((table) =>
    db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
  )
}

/** Run on the original facade before transferring import ownership. */
describe('PU-66 import storage owner contracts', () => {
  it('keeps inspect property/input order, raw-key duplicates, no-op and clock receiver', () => {
    const clockContext = {}
    const receivers: unknown[] = []
    let calls = 0
    const { store, raw, entries } = setup(
      function (this: unknown) {
        receivers.push(this)
        return `2030-02-01T00:00:00.${String(++calls).padStart(3, '0')}Z`
      }.bind(clockContext),
    )
    const first = entries[0]!,
      second = entries[1]!
    expect(store.pu66Imports.inspect([second, first])).toEqual(
      [second, first].map((entry) => ({
        filename: entry.filename,
        referenceId: entry.card.key,
        location: '88 км 3 пк',
        roadName: entry.card.roadName,
        action: 'add',
        currentRevision: 0,
        sourceSha256: entry.sha256,
        status: null,
      })),
    )
    expect(Object.keys(store.pu66Imports.inspect([first])[0]!)).toEqual([
      'filename',
      'referenceId',
      'location',
      'roadName',
      'action',
      'currentRevision',
      'sourceSha256',
      'status',
    ])
    expect(() => store.pu66Imports.record([first, first])).toThrow(
      `Повторный ключ ПУ-66: ${first.card.key}.`,
    )
    expect(raw.prepare('SELECT COUNT(*) AS count FROM pu66_sources').get()).toEqual({ count: 0 })
    calls = 0
    expect(store.pu66Imports.record([second, first])).toEqual({
      added: 2,
      updated: 0,
      unchanged: 0,
    })
    expect(calls).toBe(2)
    expect(receivers.at(-1)).toBe(clockContext)
    expect(raw.prepare('SELECT key, updated_at FROM pu66_cards ORDER BY rowid').all()).toEqual([
      { key: second.card.key, updated_at: '2030-02-01T00:00:00.001Z' },
      { key: first.card.key, updated_at: '2030-02-01T00:00:00.002Z' },
    ])
    const before = snapshot(raw)
    calls = 0
    expect(
      store.pu66Imports.record([
        {
          ...first,
          filename: 'renamed.xlsx',
          card: { ...first.card, roadName: 'Ignored without a changed SHA' },
        },
      ]),
    ).toEqual({ added: 0, updated: 0, unchanged: 1 })
    expect(snapshot(raw)).toEqual(before)
    expect(calls).toBe(0)
  })

  it('rolls back sources/current/revisions and earlier restores when the second restore fails', () => {
    const { store, raw, entries } = setup()
    store.pu66Imports.record(entries)
    const input = {
      action: 'exclude' as const,
      keys: entries.map((entry) => entry.card.key),
      date: '2030-01-30',
      actor: 'Учебный специалист',
      reason: 'closed' as const,
      comment: 'Вымышленное исключение',
      successorKey: null,
    }
    store.pu66LifecycleService.record(input, store.pu66LifecycleService.plan(input).fingerprint)
    const changed = entries.map((entry) =>
        readEntry({ ...entry.card, roadName: 'Изменённая учебная дорога' }, 'changed'),
      ),
      restoration = { keys: input.keys, date: input.date, actor: '  Учебный специалист  ' },
      before = snapshot(raw),
      plan = store.pu66Imports.inspect(changed)
    raw.exec(
      `CREATE TRIGGER reject_restore AFTER INSERT ON pu66_lifecycle WHEN NEW.action = 'restore' AND NEW.key = '99999:89:4' BEGIN SELECT RAISE(ABORT, 'restore failed'); END`,
    )
    expect(() => store.pu66Imports.record(changed, restoration)).toThrow('restore failed')
    expect(snapshot(raw)).toEqual(before)
    expect(store.pu66Imports.inspect(changed)).toEqual(plan)
    raw.exec('DROP TRIGGER reject_restore')
    expect(store.pu66Imports.record(changed, restoration)).toEqual({
      added: 0,
      updated: 2,
      unchanged: 0,
    })
    for (const entry of entries) {
      expect(store.pu66Lifecycle.getStatus(entry.card.key)?.event).toMatchObject({
        action: 'restore',
        cardRevision: 2,
        actor: restoration.actor,
        reason: null,
        comment: 'Возврат при импорте XLSX.',
        successorKey: null,
      })
      expect(store.pu66Lifecycle.list(entry.card.key)).toHaveLength(2)
    }
    expect(() => store.pu66Imports.record(changed, restoration)).toThrow()
  })

  it('validates restoration membership before lifecycle validation and does not silently restore on import', () => {
    const { store, raw, entries } = setup(),
      restoration = { keys: ['missing'], date: '9999-01-01', actor: '' }
    expect(() => store.pu66Imports.record(entries, restoration)).toThrow(
      new InvalidPu66Lifecycle('Карточка для возврата отсутствует в пакете импорта.'),
    )
    expect(raw.prepare('SELECT COUNT(*) AS count FROM pu66_cards').get()).toEqual({ count: 0 })
    store.pu66Imports.record(entries)
    const input = {
      action: 'exclude' as const,
      keys: [entries[0]!.card.key],
      date: '2030-01-30',
      actor: 'Учебный специалист',
      reason: 'closed' as const,
      comment: '',
      successorKey: null,
    }
    store.pu66LifecycleService.record(input, store.pu66LifecycleService.plan(input).fingerprint)
    store.pu66Imports.record([readEntry(entries[0]!.card, 'changed')])
    expect(store.pu66Lifecycle.getStatus(entries[0]!.card.key)?.excluded).toBe(true)
    expect(store.pu66Lifecycle.list(entries[0]!.card.key)).toHaveLength(1)
  })
})
