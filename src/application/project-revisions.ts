import type { ProjectRecord } from '../domain/local-projects'
import { schemeSchema, type Scheme } from '../domain/model'

/** Only the two transactional writes needed by revision workflows. */
export interface ProjectRevisionRepository {
  save(scheme: Scheme, expectedRevision: number): Promise<ProjectRecord>
  restore(id: string, sourceRevision: number, expectedRevision: number): Promise<ProjectRecord>
}

export class ProjectRevisionError extends Error {
  readonly code: 'conflict' | 'unavailable' | 'invalid-response' | 'failed'

  constructor(code: ProjectRevisionError['code'], message: string) {
    super(message)
    this.name = 'ProjectRevisionError'
    this.code = code
  }
}

/** Monotonic editor identity: reopening the same project is a different session. */
export type RevisionCursor = { session: number; edit: number }
export type RevisionWriteResult = {
  record: ProjectRecord
  delivery: 'current' | 'edited' | 'switched'
}

export function revisionDelivery(
  started: RevisionCursor,
  current: RevisionCursor,
): RevisionWriteResult['delivery'] {
  if (started.session !== current.session) return 'switched'
  return started.edit === current.edit ? 'current' : 'edited'
}

function complete(
  record: ProjectRecord,
  id: string,
  expectedRevision: number,
  started: RevisionCursor,
  current: () => RevisionCursor,
  allowUnchangedRevision = false,
): RevisionWriteResult {
  const validRevision =
    record.revision === expectedRevision + 1 ||
    (allowUnchangedRevision && expectedRevision > 0 && record.revision === expectedRevision)
  if (record.scheme.id !== id || !validRevision)
    throw new ProjectRevisionError(
      'invalid-response',
      'Локальная база вернула другую редакцию проекта. Обновите список проектов.',
    )
  return { record, delivery: revisionDelivery(started, current()) }
}

/** Captures one immutable Scheme; never retries a conflict or writes newer input implicitly. */
export async function SaveProjectRevision(
  repository: ProjectRevisionRepository,
  input: {
    scheme: Scheme
    expectedRevision: number
    cursor: RevisionCursor
    copy?: { id: string; createdAt: string }
  },
  current: () => RevisionCursor,
): Promise<RevisionWriteResult> {
  const scheme = input.copy ? schemeSchema.parse({ ...input.scheme, ...input.copy }) : input.scheme
  const expectedRevision = input.copy ? 0 : input.expectedRevision
  const record = await repository.save(scheme, expectedRevision)
  // SQLite does not add an identical snapshot twice; its revision may stay unchanged.
  return complete(record, scheme.id, expectedRevision, input.cursor, current, true)
}

/** Restore creates a revision; only a still-current editor may replace its open document. */
export async function RestoreProjectRevision(
  repository: ProjectRevisionRepository,
  input: {
    id: string
    sourceRevision: number
    expectedRevision: number
    cursor: RevisionCursor
  },
  current: () => RevisionCursor,
): Promise<RevisionWriteResult> {
  const record = await repository.restore(input.id, input.sourceRevision, input.expectedRevision)
  return complete(record, input.id, input.expectedRevision, input.cursor, current)
}
