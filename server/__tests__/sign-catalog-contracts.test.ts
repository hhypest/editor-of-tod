import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { RegistryStore } from '../store'
import { catalogEntry, catalogSource } from './sign-catalog-fixture'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})
function setup(clock: () => string = () => '2030-02-01T00:00:00.000Z') {
  const directory = mkdtempSync(join(tmpdir(), 'tod-sign-contract-')),
    path = join(directory, 'registry.sqlite'),
    store = new RegistryStore(path, clock),
    raw = new DatabaseSync(path)
  cleanups.push(() => {
    raw.close()
    store.close()
    rmSync(directory, { recursive: true, force: true })
  })
  return { store, raw }
}
function snapshot(db: DatabaseSync) {
  return ['sign_catalog_batches', 'signs', 'sign_active', 'sign_revisions'].map((table) =>
    db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
  )
}

/** Run on the original RegistryStore before catalog ownership moves. */
describe('sign catalog facade contracts', () => {
  it('keeps plan order, clock receiver, no-op, source relabel, retirement and reactivation history', () => {
    let calls = 0
    const receivers: unknown[] = []
    const { store, raw } = setup(function (this: unknown) {
        calls++
        receivers.push(this)
        return '2030-02-01T00:00:00.000Z'
      }),
      first = catalogEntry('9.98', 100),
      second = catalogEntry('9.99', 120),
      entries = [second, first],
      source = catalogSource()
    expect(store.planSigns(entries, source)).toEqual({
      added: 2,
      updated: 0,
      unchanged: 0,
      retired: 0,
      relabelled: 0,
      addedCodes: ['9.99', '9.98'],
      changedCodes: [],
      retiredCodes: [],
    })
    expect(() => store.importSigns([first, first], source)).toThrow('Повторный код знака: 9.98.')
    expect(store.latestSignCatalog()).toBeNull()
    calls = 0
    store.importSigns(entries, source)
    expect(calls).toBe(3)
    expect(receivers.at(-1)).toBe(store)
    const before = snapshot(raw),
      batch = store.latestSignCatalog(),
      history = raw.prepare('SELECT * FROM sign_revisions ORDER BY code').all()
    calls = 0
    expect(
      store.importSigns(
        entries.map((entry) => ({ ...entry, zipSha256: 'f'.repeat(64) })),
        source,
      ),
    ).toMatchObject({ unchanged: 2, added: 0, updated: 0 })
    expect(snapshot(raw)).toEqual(before)
    expect(calls).toBe(0)
    const nextSource = catalogSource({ edition: '2031' })
    expect(store.importSigns(entries, nextSource)).toMatchObject({
      updated: 2,
      relabelled: 2,
      changedCodes: [],
    })
    expect(calls).toBe(1)
    expect(store.latestSignCatalog()?.id).toBe(batch!.id + 1)
    expect(raw.prepare('SELECT * FROM sign_revisions ORDER BY code').all()).toEqual(history)
    expect(store.importSigns([first], nextSource)).toMatchObject({
      retired: 1,
      retiredCodes: ['9.99'],
    })
    expect(store.getSignPng(second.code, false)).toBeNull()
    expect(Buffer.from(store.getSignPng(second.code, false, 1)!)).toEqual(second.plainPng)
    expect(store.getSignMetadata(second.code, 1)).toEqual({
      code: second.code,
      revision: 1,
      width: 8,
      height: 6,
    })
    expect(store.getSignPng(second.code, false, 2)).toBeNull()
    expect(store.importSigns(entries, nextSource)).toMatchObject({
      added: 1,
      addedCodes: [second.code],
    })
    expect(store.listSigns().find((sign) => sign.code === second.code)?.revision).toBe(3)
    expect(
      raw
        .prepare('SELECT revision, active FROM sign_revisions WHERE code = ? ORDER BY revision')
        .all(second.code),
    ).toEqual([
      { revision: 1, active: 1 },
      { revision: 2, active: 0 },
      { revision: 3, active: 1 },
    ])
  })

  it('rolls back batch/current/active/history when a late retirement insert fails and permits the same retry', () => {
    const { store, raw } = setup(),
      first = catalogEntry('9.98', 100),
      retired = catalogEntry('9.99', 120),
      source = catalogSource()
    store.importSigns([first, retired], source)
    const entries = [catalogEntry(first.code, 140, 16, 12), catalogEntry('9.97', 160)],
      before = snapshot(raw),
      plan = store.planSigns(entries, source)
    raw.exec(
      "CREATE TRIGGER reject_retirement AFTER INSERT ON sign_revisions WHEN NEW.code = '9.99' AND NEW.active = 0 BEGIN SELECT RAISE(ABORT, 'retirement failed'); END",
    )
    expect(() => store.importSigns(entries, source)).toThrow('retirement failed')
    expect(snapshot(raw)).toEqual(before)
    expect(store.planSigns(entries, source)).toEqual(plan)
    raw.exec('DROP TRIGGER reject_retirement')
    expect(store.importSigns(entries, source)).toEqual(plan)
    expect(store.listSigns().map((sign) => sign.code)).toEqual(['9.97', '9.98'])
    expect(store.getSignMetadata(first.code, 1)).toMatchObject({ width: 8, height: 6 })
    expect(store.getSignMetadata(first.code, 2)).toMatchObject({ width: 16, height: 12 })
  })
})
