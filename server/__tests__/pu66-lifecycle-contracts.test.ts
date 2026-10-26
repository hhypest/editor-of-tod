import { openTestApplication } from './test-application'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import type { Pu66LifecycleWrite } from '../../src/domain/pu66-lifecycle'
import { RevisionConflict } from '../storage-errors'
import { readCard, readEntry } from './pu66-read-fixture'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})
const exclude = (keys: string[]): Pu66LifecycleWrite => ({
  action: 'exclude',
  keys,
  date: '2030-01-30',
  actor: 'Учебный специалист',
  reason: 'reassigned',
  comment: 'Вымышленное исключение',
  successorKey: null,
})
function setup(clock: () => string = () => '2030-02-01T00:00:00.000Z') {
  const directory = mkdtempSync(join(tmpdir(), 'tod-lifecycle-contract-')),
    path = join(directory, 'registry.sqlite'),
    store = openTestApplication(path, clock),
    raw = new DatabaseSync(path),
    cards = [readCard('99999:88:3'), readCard('99999:89:4')]
  cleanups.push(() => {
    raw.close()
    store.runtime.close()
    rmSync(directory, { recursive: true, force: true })
  })
  store.pu66Imports.record(cards.map((card) => readEntry(card)))
  return { store, raw, cards }
}

/** These contracts first run on RegistryStore before the lifecycle transfer. */
describe('PU-66 lifecycle storage owner contracts', () => {
  it('keeps clock receiver, plan normalization, raw command fields and shared batch timestamp', () => {
    const clockContext = {}
    const receivers: unknown[] = []
    let calls = 0
    const { store, cards } = setup(
      function (this: unknown) {
        receivers.push(this)
        return `2030-02-01T00:00:00.${String(++calls).padStart(3, '0')}Z`
      }.bind(clockContext),
    )
    const input = {
      ...exclude(cards.map((card) => card.key)),
      actor: '  Учебный специалист  ',
      comment: '  Вымышленное исключение  ',
    }
    const plan = store.pu66LifecycleService.plan(input)
    expect(plan).toEqual(
      store.pu66LifecycleService.plan({
        ...input,
        actor: input.actor.trim(),
        comment: input.comment.trim(),
      }),
    )
    calls = 0
    expect(store.pu66LifecycleService.record(input, plan.fingerprint)).toBe(2)
    expect(calls).toBe(2)
    expect(receivers.at(-1)).toBe(clockContext)
    for (const card of cards)
      expect(store.pu66Lifecycle.getStatus(card.key)?.event).toMatchObject({
        actor: input.actor,
        comment: input.comment,
        cardRevision: 1,
        recordedAt: '2030-02-01T00:00:00.002Z',
      })
    expect(() => store.pu66LifecycleService.record(input, plan.fingerprint)).toThrow(
      RevisionConflict,
    )
    expect(store.pu66Lifecycle.list(cards[0]!.key)).toHaveLength(1)
  })

  it('rolls back every event when the second insert fails and leaves the same preview usable', () => {
    const { store, raw, cards } = setup(),
      input = exclude(cards.map((card) => card.key)),
      plan = store.pu66LifecycleService.plan(input),
      before = raw.prepare('SELECT * FROM pu66_cards ORDER BY key').all()
    raw.exec(
      `CREATE TRIGGER fail_second_lifecycle AFTER INSERT ON pu66_lifecycle WHEN NEW.key = '99999:89:4' BEGIN SELECT RAISE(ABORT, 'second event failed'); END`,
    )
    expect(() => store.pu66LifecycleService.record(input, plan.fingerprint)).toThrow(
      'second event failed',
    )
    expect(raw.prepare('SELECT COUNT(*) AS count FROM pu66_lifecycle').get()).toEqual({ count: 0 })
    expect(store.pu66LifecycleService.plan(input)).toEqual(plan)
    raw.exec('DROP TRIGGER fail_second_lifecycle')
    expect(store.pu66LifecycleService.record(input, plan.fingerprint)).toBe(2)
    expect(raw.prepare('SELECT * FROM pu66_cards ORDER BY key').all()).toEqual(before)
    expect(raw.prepare('SELECT COUNT(*) AS count FROM pu66_revisions').get()).toEqual({ count: 2 })
  })
})
