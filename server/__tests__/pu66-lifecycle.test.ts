import { openTestApplication, type TestApplication } from './test-application'
import { mkdtempSync, readdirSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSampleWorkbook, sampleCards } from '../../scripts/generate-pu66-samples'
import { importSchemeJson } from '../../src/domain/import'
import { linkPu66Card } from '../../src/domain/link-pu66'
import type { Pu66LifecycleWrite } from '../../src/domain/pu66-lifecycle'
import { RevisionConflict } from '../storage-errors'
import { InvalidPu66Lifecycle } from '../pu66/errors'
import { parsePu66, type Pu66Import } from '../pu66'
import { applyPu66Lifecycle } from '../pu66-lifecycle'
import { applyPu66Upload, previewPu66Upload } from '../pu66-web-import'
import { createHttpServer } from '../http/server'

let directory: string
let path: string
let store: TestApplication
let entries: Pu66Import[]
const now = () => '2026-10-02T10:00:00.000Z'
const exclude = (
  keys: string[],
  successorKey: string | null = null,
): Extract<Pu66LifecycleWrite, { action: 'exclude' }> => ({
  action: 'exclude',
  keys,
  date: '2026-10-02',
  actor: 'Учебный составитель',
  reason: 'reassigned',
  comment: 'Вымышленная передача участка',
  successorKey,
})
const restore = (keys: string[]): Extract<Pu66LifecycleWrite, { action: 'restore' }> => ({
  action: 'restore',
  keys,
  date: '2026-10-02',
  actor: 'Учебный составитель',
  comment: 'Вымышленный возврат',
})
const write = (input: Pu66LifecycleWrite) =>
  store.pu66LifecycleService.record(input, store.pu66LifecycleService.plan(input).fingerprint)
const upload = (entry: Pu66Import) => ({
  name: entry.filename,
  data: entry.source.toString('base64'),
})

// Generate immutable XLSX inputs once; each test still imports them into a fresh database.
beforeAll(async () => {
  entries = await Promise.all(
    sampleCards
      .slice(0, 3)
      .map(async (card) => parsePu66(await createSampleWorkbook(card), card.filename)),
  )
}, 30000)
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'tod-lifecycle-'))
  path = join(directory, 'registry.sqlite')
  store = openTestApplication(path, now)
  store.pu66Imports.record(entries)
})
afterEach(() => {
  store.runtime.close()
  rmSync(directory, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('PU-66 lifecycle and preserved data', () => {
  it.each([false, true])(
    'rejects an updated successor, including during backup (%s)',
    async (duringBackup) => {
      const first = entries[0]!.card.key
      const successor = entries[2]!.card.key
      const input = exclude([first], successor)
      const plan = store.pu66LifecycleService.plan(input)
      expect(plan.successor).toMatchObject({ referenceId: successor, revision: 1 })
      const changed = await parsePu66(
        await createSampleWorkbook({ ...sampleCards[2]!, road: 'Новая учебная дорога преемника' }),
        entries[2]!.filename,
      )
      if (duringBackup) {
        const backup = store.runtime.http.createBackup.bind(store)
        vi.spyOn(store.runtime.http.pu66.lifecycleCommands, 'createBackup').mockImplementation(
          async () => {
            const filename = await backup()
            store.pu66Imports.record([changed])
            return filename
          },
        )
      } else store.pu66Imports.record([changed])
      await expect(
        applyPu66Lifecycle(store.runtime.http.pu66.lifecycleCommands, {
          input,
          expectedFingerprint: plan.fingerprint,
        }),
      ).rejects.toThrow(RevisionConflict)
      expect(store.pu66Lifecycle.getStatus(first)?.excluded).toBe(false)
      expect(store.pu66Lifecycle.list(first)).toEqual([])
      expect(store.pu66.getScheme(successor)?.revision).toBe(2)
    },
  )
  it('excludes a batch after backup, preserves project snapshots, books and verification history, then restores', async () => {
    const first = entries[0]!.card.key
    const second = entries[1]!.card.key
    const successor = entries[2]!.card.key
    store.pu66Verifications.record(first, {
      expectedRevision: 1,
      verifiedAt: '2026-01-30',
      verifiedBy: 'Учебный проверяющий',
    })
    const project = linkPu66Card(
      importSchemeJson(
        readFileSync(new URL('../../tests/fixtures/manual-v1.json', import.meta.url), 'utf8'),
      ).scheme,
      store.pu66.getScheme(first)!,
    )
    store.projects.save(project, 0)
    const input = exclude([first, second], successor)
    const plan = store.pu66LifecycleService.plan(input)
    expect(store.pu66.list()).toHaveLength(3)
    expect(readdirSync(directory)).not.toContain('backups')
    const applied = await applyPu66Lifecycle(store.runtime.http.pu66.lifecycleCommands, {
      input,
      expectedFingerprint: plan.fingerprint,
    })
    expect(applied).toMatchObject({ changed: 2, backup: expect.stringMatching(/\.sqlite$/) })
    expect(store.pu66.list().map((card) => card.referenceId)).toEqual([successor])
    expect(store.pu66.list(true)).toHaveLength(3)
    expect(store.pu66Lifecycle.getStatus(first)).toMatchObject({
      excluded: true,
      successorKey: successor,
      event: { actor: 'Учебный составитель', reason: 'reassigned', cardRevision: 1 },
    })
    expect(store.projects.get(project.id)?.scheme).toEqual(project)
    expect(store.pu66Verifications.list(first)).toHaveLength(1)
    expect(() =>
      store.pu66Verifications.record(first, {
        expectedRevision: 1,
        verifiedAt: '2026-10-02',
        verifiedBy: 'Учебный проверяющий',
      }),
    ).toThrow(InvalidPu66Lifecycle)
    const backup = openTestApplication(join(directory, 'backups', applied.backup!), now)
    try {
      expect(backup.pu66.list()).toHaveLength(3)
      expect(backup.projects.get(project.id)?.scheme).toEqual(project)
    } finally {
      backup.runtime.close()
    }
    await applyPu66Lifecycle(store.runtime.http.pu66.lifecycleCommands, {
      input: restore([first]),
      expectedFingerprint: store.pu66LifecycleService.plan(restore([first])).fingerprint,
    })
    expect(store.pu66Lifecycle.getStatus(first)).toMatchObject({
      excluded: false,
      successorKey: null,
    })
    expect(store.pu66Lifecycle.list(first)?.map((event) => event.action)).toEqual([
      'restore',
      'exclude',
    ])
    expect(store.pu66.list()).toHaveLength(2)
    expect(store.projects.get(project.id)?.scheme).toEqual(project)
    store.runtime.close()
    const db = new DatabaseSync(path)
    try {
      expect(db.prepare('SELECT COUNT(*) AS count FROM pu66_sources').get()).toMatchObject({
        count: 3,
      })
      expect(db.prepare('SELECT COUNT(*) AS count FROM pu66_revisions').get()).toMatchObject({
        count: 3,
      })
      expect(db.prepare('SELECT COUNT(*) AS count FROM project_revisions').get()).toMatchObject({
        count: 1,
      })
    } finally {
      db.close()
    }
    store = openTestApplication(path, now)
    expect(store.pu66Lifecycle.getStatus(second)?.excluded).toBe(true)
    expect(store.pu66Lifecycle.list(first)).toHaveLength(2)
  })

  it('rejects invalid reasons, future dates, unknown cards and invalid successor links without changing any selected card', () => {
    const keys = entries.map((entry) => entry.card.key)
    expect(() =>
      store.pu66LifecycleService.plan({ ...exclude([keys[0]!]), reason: 'other', comment: '' }),
    ).toThrow()
    expect(() =>
      store.pu66LifecycleService.plan({ ...exclude([keys[0]!]), date: '2026-10-03' }),
    ).toThrow(InvalidPu66Lifecycle)
    expect(() => store.pu66LifecycleService.plan(exclude([keys[0]!, 'MISSING']))).toThrow(
      InvalidPu66Lifecycle,
    )
    expect(() => store.pu66LifecycleService.plan(exclude([keys[0]!, keys[0]!]))).toThrow()
    expect(() => store.pu66LifecycleService.plan(exclude([keys[0]!], keys[0]!))).toThrow(
      InvalidPu66Lifecycle,
    )
    expect(() => store.pu66LifecycleService.plan(exclude([keys[0]!], 'MISSING'))).toThrow(
      InvalidPu66Lifecycle,
    )
    write(exclude([keys[2]!]))
    expect(() => store.pu66LifecycleService.plan(exclude([keys[0]!], keys[2]!))).toThrow(
      InvalidPu66Lifecycle,
    )
    expect(() => store.pu66LifecycleService.plan(restore([keys[1]!]))).toThrow(RevisionConflict)
    expect(store.pu66Lifecycle.getStatus(keys[0]!)?.excluded).toBe(false)
    expect(store.pu66Lifecycle.getStatus(keys[1]!)?.excluded).toBe(false)
  })

  it('rejects a changed or replayed plan and rolls back the whole batch', async () => {
    const keys = entries.slice(0, 2).map((entry) => entry.card.key)
    const input = exclude(keys)
    const plan = store.pu66LifecycleService.plan(input)
    await expect(
      applyPu66Lifecycle(store.runtime.http.pu66.lifecycleCommands, {
        input: { ...input, actor: 'Другой составитель' },
        expectedFingerprint: plan.fingerprint,
      }),
    ).rejects.toThrow(RevisionConflict)
    expect(readdirSync(directory)).not.toContain('backups')
    write(exclude([keys[1]!]))
    expect(() => store.pu66LifecycleService.record(input, plan.fingerprint)).toThrow(
      RevisionConflict,
    )
    expect(store.pu66Lifecycle.getStatus(keys[0]!)?.excluded).toBe(false)
    const fresh = store.pu66LifecycleService.plan(exclude([keys[0]!]))
    write(exclude([keys[0]!]))
    expect(() => store.pu66LifecycleService.record(exclude([keys[0]!]), fresh.fingerprint)).toThrow(
      RevisionConflict,
    )
    expect(store.pu66Lifecycle.list(keys[0]!)).toHaveLength(1)
  })

  it('rechecks status and successor after asynchronous backup', async () => {
    const first = entries[0]!.card.key
    const successor = entries[2]!.card.key
    const input = exclude([first], successor)
    const plan = store.pu66LifecycleService.plan(input)
    const originalBackup = store.runtime.http.createBackup.bind(store)
    vi.spyOn(store.runtime.http.pu66.lifecycleCommands, 'createBackup').mockImplementation(
      async () => {
        const backup = await originalBackup()
        write(exclude([successor]))
        return backup
      },
    )
    await expect(
      applyPu66Lifecycle(store.runtime.http.pu66.lifecycleCommands, {
        input,
        expectedFingerprint: plan.fingerprint,
      }),
    ).rejects.toThrow(InvalidPu66Lifecycle)
    expect(store.pu66Lifecycle.getStatus(first)?.excluded).toBe(false)
    expect(store.pu66Lifecycle.list(first)).toEqual([])
  })

  it('does not revive excluded cards through unchanged, changed or CLI-style imports, and supports explicit XLSX restoration', async () => {
    const entry = entries[0]!
    write(exclude([entry.card.key]))
    const files = [upload(entry)]
    const plan = await previewPu66Upload(store.runtime.http.pu66.importCommands, { files })
    expect(plan).toMatchObject({
      restored: 0,
      items: [{ status: { excluded: true, event: { reason: 'reassigned' } } }],
    })
    expect(
      await applyPu66Upload(store.runtime.http.pu66.importCommands, {
        files,
        expectedFingerprint: plan.fingerprint,
      }),
    ).toMatchObject({ backup: null, restored: 0 })
    const changed = await parsePu66(
      await createSampleWorkbook({ ...sampleCards[0]!, road: 'Обновлённая вымышленная дорога' }),
      entry.filename,
    )
    const changedPlan = await previewPu66Upload(store.runtime.http.pu66.importCommands, {
      files: [upload(changed)],
    })
    await applyPu66Upload(store.runtime.http.pu66.importCommands, {
      files: [upload(changed)],
      expectedFingerprint: changedPlan.fingerprint,
    })
    expect(store.pu66Lifecycle.getStatus(entry.card.key)?.excluded).toBe(true)
    store.pu66Imports.record([entry])
    expect(store.pu66Lifecycle.getStatus(entry.card.key)?.excluded).toBe(true)
    const restoration = { keys: [entry.card.key], date: '2026-10-02', actor: 'Учебный составитель' }
    const restorePlan = await previewPu66Upload(store.runtime.http.pu66.importCommands, {
      files,
      restoration,
    })
    expect(restorePlan).toMatchObject({ unchanged: 1, restored: 1 })
    await expect(
      applyPu66Upload(store.runtime.http.pu66.importCommands, {
        files,
        restoration,
        expectedFingerprint: plan.fingerprint,
      }),
    ).rejects.toThrow(RevisionConflict)
    expect(
      await applyPu66Upload(store.runtime.http.pu66.importCommands, {
        files,
        restoration,
        expectedFingerprint: restorePlan.fingerprint,
      }),
    ).toMatchObject({ restored: 1, backup: expect.any(String) })
    expect(store.pu66Lifecycle.getStatus(entry.card.key)?.excluded).toBe(false)
    expect(store.pu66Lifecycle.list(entry.card.key)).toMatchObject([
      { action: 'restore', cardRevision: 3 },
      { action: 'exclude', cardRevision: 1 },
    ])
    expect(store.pu66.getScheme(entry.card.key)?.revision).toBe(3)
  })

  it('makes import previews stale when the lifecycle changes, including during backup', async () => {
    const entry = entries[0]!
    const files = [upload(entry)]
    const activePlan = await previewPu66Upload(store.runtime.http.pu66.importCommands, { files })
    write(exclude([entry.card.key]))
    await expect(
      applyPu66Upload(store.runtime.http.pu66.importCommands, {
        files,
        expectedFingerprint: activePlan.fingerprint,
      }),
    ).rejects.toThrow(RevisionConflict)
    const restoration = { keys: [entry.card.key], date: '2026-10-02', actor: 'Учебный составитель' }
    const plan = await previewPu66Upload(store.runtime.http.pu66.importCommands, {
      files,
      restoration,
    })
    const originalBackup = store.runtime.http.createBackup.bind(store)
    vi.spyOn(store.runtime.http.pu66.importCommands, 'createBackup').mockImplementation(
      async () => {
        const backup = await originalBackup()
        write(restore([entry.card.key]))
        write(exclude([entry.card.key]))
        return backup
      },
    )
    await expect(
      applyPu66Upload(store.runtime.http.pu66.importCommands, {
        files,
        restoration,
        expectedFingerprint: plan.fingerprint,
      }),
    ).rejects.toThrow(RevisionConflict)
    expect(store.pu66Lifecycle.getStatus(entry.card.key)?.excluded).toBe(true)
    expect(store.pu66.getScheme(entry.card.key)?.revision).toBe(1)
  })

  it('migrates a database v11 without changing imported cards, project snapshots or revision history', () => {
    const first = entries[0]!.card.key
    const snapshot = store.pu66.getScheme(first)
    store.runtime.close()
    const raw = new DatabaseSync(path)
    raw.exec(
      'ALTER TABLE project_recovery DROP COLUMN owner_id; ALTER TABLE project_recovery DROP COLUMN owner_until; DROP TABLE pu66_lifecycle; PRAGMA user_version = 11',
    )
    raw.close()
    store = openTestApplication(path, now)
    expect(store.runtime.schemaVersion()).toBe(13)
    expect(store.pu66.getScheme(first)).toEqual(snapshot)
    expect(store.pu66.list()).toHaveLength(3)
    expect(store.pu66Lifecycle.getStatus(first)).toMatchObject({ excluded: false, event: null })
  })

  it('protects lifecycle writes with local-origin checks, omits inactive cards and refuses new links to them', async () => {
    const server = createHttpServer(store.runtime.http, 0)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing test server address')
    const root = `http://127.0.0.1:${address.port}/api/pu66`
    const key = entries[0]!.card.key
    const input = exclude([key])
    const post = (endpoint: string, body: unknown, origin = true) =>
      fetch(`${root}/lifecycle/${endpoint}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(origin ? { Origin: 'http://127.0.0.1:5173' } : {}),
        },
        body: JSON.stringify(body),
      })
    try {
      expect((await post('preview', input, false)).status).toBe(403)
      const plan = (await (await post('preview', input)).json()) as { fingerprint: string }
      expect((await post('apply', { input, expectedFingerprint: plan.fingerprint })).status).toBe(
        200,
      )
      expect(await (await fetch(root)).json()).toHaveLength(2)
      expect(await (await fetch(`${root}/lifecycle`)).json()).toHaveLength(3)
      expect((await fetch(`${root}/${encodeURIComponent(key)}/scheme`)).status).toBe(400)
      expect(await (await fetch(`${root}/${encodeURIComponent(key)}/status`)).json()).toMatchObject(
        { excluded: true },
      )
      expect(
        await (await fetch(`${root}/${encodeURIComponent(key)}/lifecycle`)).json(),
      ).toHaveLength(1)
      expect(await (await fetch(`${root}/MISSING/status`)).json()).toBeNull()
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
