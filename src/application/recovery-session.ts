import type { RecoveryRecord, RecoveryWrite } from '../domain/recovery'

export const RECOVERY_LEASE_MS = 120_000
export const RECOVERY_HEARTBEAT_MS = 20_000

export function recoveryIsActive(until: number, now: number): boolean {
  return until > now
}

export type RecoveryReceipt = { version: number; updatedAt: string; sourceSha256?: string }
export type RecoverySnapshot = Omit<RecoveryWrite, 'expectedVersion'>

/** The adapter supplies HTTP/SQLite details and the owner identity of this window. */
export interface RecoveryRepository {
  save(input: RecoveryWrite, sourceSha256?: string): Promise<RecoveryReceipt>
  claim(sessionId: string, expectedVersion: number): Promise<RecoveryRecord>
  remove(sessionId: string, expectedVersion: number): Promise<void>
  heartbeat(sessionId: string): Promise<void>
  release(sessionId: string): Promise<void>
}

/** Serializes snapshots and ownership changes without Vue, timers or browser globals. */
export class RecoverySession {
  private queue: Promise<unknown> = Promise.resolve()
  private versions = new Map<string, number>()
  private sources = new Map<string, { text: string; sha256: string }>()

  private readonly repository: RecoveryRepository

  constructor(repository: RecoveryRepository) {
    this.repository = repository
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation)
    this.queue = result.catch(() => undefined)
    return result
  }

  version(sessionId: string): number {
    return this.versions.get(sessionId) ?? 0
  }

  save(snapshot: RecoverySnapshot): Promise<void> {
    return this.enqueue(async () => {
      const source = snapshot.scheme.source
      const cached = this.sources.get(snapshot.sessionId)
      const reference =
        source.kind === 'legacy-html-v1' && cached?.text === source.originalJson
          ? cached.sha256
          : undefined
      const saved = await this.repository.save(
        {
          ...snapshot,
          expectedVersion: this.version(snapshot.sessionId),
        },
        reference,
      )
      this.versions.set(snapshot.sessionId, saved.version)
      this.sources.delete(snapshot.sessionId)
      if (source.kind === 'legacy-html-v1' && saved.sourceSha256)
        this.sources.set(snapshot.sessionId, {
          text: source.originalJson,
          sha256: saved.sourceSha256,
        })
    })
  }

  claim(sessionId: string, version: number): Promise<RecoveryRecord> {
    return this.enqueue(async () => {
      const record = await this.repository.claim(sessionId, version)
      this.versions.set(sessionId, record.version)
      this.sources.delete(sessionId)
      return record
    })
  }

  remove(sessionId: string, version?: number): Promise<void> {
    return this.enqueue(async () => {
      // Read our queued version only when the caller did not supply a list snapshot.
      const expected = version ?? this.version(sessionId)
      if (!expected) return
      await this.repository.remove(sessionId, expected)
      this.versions.delete(sessionId)
      this.sources.delete(sessionId)
    })
  }

  heartbeat(sessionId: string): Promise<void> {
    return this.enqueue(async () => {
      if (this.version(sessionId)) await this.repository.heartbeat(sessionId)
    })
  }

  release(sessionId: string): Promise<void> {
    return this.enqueue(async () => {
      if (this.version(sessionId)) await this.repository.release(sessionId)
      // A source can be 10 MB; closed projects must not accumulate in this window's cache.
      this.sources.delete(sessionId)
    })
  }
}
