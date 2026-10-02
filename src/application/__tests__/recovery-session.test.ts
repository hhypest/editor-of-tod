import raw from '../../../tests/fixtures/manual-v1.json?raw'
import { describe, expect, it, vi } from 'vitest'
import { importSchemeJson } from '../../domain/import'
import {
  RecoverySession,
  type RecoveryRepository,
  type RecoverySnapshot,
} from '../recovery-session'

const snapshot: RecoverySnapshot = {
  sessionId: crypto.randomUUID(),
  scheme: importSchemeJson(raw).scheme,
  baseRevision: null,
  detailsDraft: null,
  placementDraft: null,
  fileName: 'fictional.json',
}
const receipt = { version: 1, updatedAt: '2026-10-02T12:00:00.000Z', sourceSha256: 'a'.repeat(64) }
function repository(): RecoveryRepository {
  return {
    save: vi.fn().mockResolvedValue(receipt),
    claim: vi.fn(),
    remove: vi.fn().mockResolvedValue(undefined),
    heartbeat: vi.fn().mockResolvedValue(undefined),
    release: vi.fn().mockResolvedValue(undefined),
  }
}

describe('recovery application session', () => {
  it('serializes overlapping writes and deletion using the committed version and source reference', async () => {
    const repo = repository()
    let finish!: (value: typeof receipt) => void
    vi.mocked(repo.save).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    vi.mocked(repo.save).mockResolvedValueOnce({ ...receipt, version: 2 })
    const session = new RecoverySession(repo)
    const first = session.save(snapshot)
    const second = session.save(snapshot)
    const remove = session.remove(snapshot.sessionId)
    await Promise.resolve()
    expect(repo.save).toHaveBeenCalledTimes(1)
    expect(repo.remove).not.toHaveBeenCalled()
    finish(receipt)
    await Promise.all([first, second, remove])
    expect(repo.save).toHaveBeenNthCalledWith(1, { ...snapshot, expectedVersion: 0 }, undefined)
    expect(repo.save).toHaveBeenNthCalledWith(
      2,
      { ...snapshot, expectedVersion: 1 },
      receipt.sourceSha256,
    )
    expect(repo.remove).toHaveBeenCalledWith(snapshot.sessionId, 2)
    expect(session.version(snapshot.sessionId)).toBe(0)
  })

  it('does not reuse an unconfirmed source or advance versions on a failed write', async () => {
    const repo = repository()
    vi.mocked(repo.save).mockRejectedValueOnce(new Error('offline'))
    const session = new RecoverySession(repo)
    await expect(session.save(snapshot)).rejects.toThrow('offline')
    await session.save(snapshot)
    expect(repo.save).toHaveBeenLastCalledWith({ ...snapshot, expectedVersion: 0 }, undefined)
    expect(session.version(snapshot.sessionId)).toBe(1)
  })

  it('keeps copies independent and preserves optimistic checks for explicit deletion', async () => {
    const repo = repository()
    const session = new RecoverySession(repo)
    await session.save(snapshot)
    const other = { ...snapshot, sessionId: crypto.randomUUID() }
    await session.save(other)
    expect(repo.save).toHaveBeenLastCalledWith({ ...other, expectedVersion: 0 }, undefined)
    await session.remove(snapshot.sessionId, 4)
    expect(repo.remove).toHaveBeenCalledWith(snapshot.sessionId, 4)
    await session.heartbeat(other.sessionId)
    await session.release(other.sessionId)
    expect(repo.heartbeat).toHaveBeenCalledWith(other.sessionId)
    expect(repo.release).toHaveBeenCalledWith(other.sessionId)
  })
})
