import { describe, expect, it, vi } from 'vitest'
import { importSchemeJson } from '../../domain/import'
import type { ProjectRecord } from '../../domain/local-projects'
import raw from '../../../tests/fixtures/manual-v1.json?raw'
import {
  SaveProjectRevision,
  RestoreProjectRevision,
  ProjectRevisionError,
  type ProjectRevisionRepository,
  type RevisionCursor,
} from '../project-revisions'

const scheme = importSchemeJson(raw).scheme
const started: RevisionCursor = { session: 1, edit: 4 }
function repository() {
  return {
    save: vi.fn<ProjectRevisionRepository['save']>(),
    restore: vi.fn<ProjectRevisionRepository['restore']>(),
  }
}
const record = (revision: number): ProjectRecord => ({
  scheme,
  revision,
  updatedAt: '2026-10-02T10:00:00.000Z',
})

describe('revision workflows without Vue or HTTP', () => {
  it.each([
    [{ session: 1, edit: 4 }, 'current'],
    [{ session: 1, edit: 5 }, 'edited'],
    [{ session: 2, edit: 4 }, 'switched'],
  ] as const)('classifies save delivery using the editor cursor %j', async (current, delivery) => {
    const repo = repository()
    repo.save.mockResolvedValue(record(4))
    const result = await SaveProjectRevision(
      repo,
      { scheme, expectedRevision: 3, cursor: started },
      () => current,
    )
    expect(repo.save).toHaveBeenCalledExactlyOnceWith(scheme, 3)
    expect(result.delivery).toBe(delivery)
  })

  it('accepts an unchanged revision for an identical save, but restore must create a new revision', async () => {
    const repo = repository()
    repo.save.mockResolvedValue(record(3))
    await expect(
      SaveProjectRevision(repo, { scheme, expectedRevision: 3, cursor: started }, () => started),
    ).resolves.toMatchObject({ record: { revision: 3 }, delivery: 'current' })
    repo.restore.mockResolvedValue(record(3))
    await expect(
      RestoreProjectRevision(
        repo,
        { id: scheme.id, sourceRevision: 1, expectedRevision: 3, cursor: started },
        () => started,
      ),
    ).rejects.toMatchObject({ code: 'invalid-response' })
  })

  it('creates a separate revision without changing the original id or source', async () => {
    const repo = repository()
    const copy = {
      id: '11111111-1111-4111-8111-111111111111',
      createdAt: '2026-10-02T10:00:00.000Z',
    }
    repo.save.mockImplementation(async (saved, expected) => ({
      scheme: saved,
      revision: expected + 1,
      updatedAt: copy.createdAt,
    }))
    const result = await SaveProjectRevision(
      repo,
      { scheme, expectedRevision: 8, cursor: started, copy },
      () => started,
    )
    expect(repo.save.mock.calls[0]![1]).toBe(0)
    expect(result.record.scheme.id).toBe(copy.id)
    expect(result.record.scheme.source).toEqual(scheme.source)
    expect(scheme.id).not.toBe(copy.id)
  })

  it('passes optimistic concurrency through restore and does not retry conflicts', async () => {
    const repo = repository()
    const conflict = new ProjectRevisionError('conflict', 'Запись изменилась')
    repo.restore.mockRejectedValue(conflict)
    await expect(
      RestoreProjectRevision(
        repo,
        { id: scheme.id, sourceRevision: 2, expectedRevision: 4, cursor: started },
        () => started,
      ),
    ).rejects.toBe(conflict)
    expect(repo.restore).toHaveBeenCalledExactlyOnceWith(scheme.id, 2, 4)
    expect(repo.save).not.toHaveBeenCalled()
  })

  it('classifies restore replies after further edits', async () => {
    const repo = repository()
    repo.restore.mockResolvedValue(record(5))
    const result = await RestoreProjectRevision(
      repo,
      { id: scheme.id, sourceRevision: 2, expectedRevision: 4, cursor: started },
      () => ({ ...started, edit: 6 }),
    )
    expect(result.delivery).toBe('edited')
  })

  it.each(['save', 'restore'] as const)(
    'rejects an unexpected project or revision in %s acknowledgement',
    async (operation) => {
      const repo = repository()
      for (const response of [
        record(9),
        { ...record(4), scheme: { ...scheme, id: '22222222-2222-4222-8222-222222222222' } },
      ]) {
        repo[operation].mockResolvedValue(response)
        const result =
          operation === 'save'
            ? SaveProjectRevision(
                repo,
                { scheme, expectedRevision: 3, cursor: started },
                () => started,
              )
            : RestoreProjectRevision(
                repo,
                { id: scheme.id, sourceRevision: 1, expectedRevision: 3, cursor: started },
                () => started,
              )
        await expect(result).rejects.toMatchObject({ code: 'invalid-response' })
      }
    },
  )
})
