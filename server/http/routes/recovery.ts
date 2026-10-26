import { createHash } from 'node:crypto'
import { z } from 'zod'
import { MAX_LOCAL_PROJECT_BYTES } from '../../../src/domain/local-projects.ts'
import {
  recoveryDeleteSchema,
  type RecoveryRecord,
  type RecoverySummary,
} from '../../../src/domain/recovery.ts'
import {
  recoveryClaimSchema,
  recoveryOwnerSchema,
  recoveryTransferSchema,
} from '../../../src/application/recovery-contract.ts'
import type {
  ClaimRecovery,
  OwnedRecovery,
  SaveRecovery,
  DeleteRecovery,
} from '../../recovery/recovery-repository.ts'
import { RequestError } from '../request-error.ts'
import { json, readJson } from '../json.ts'
import { projectId } from '../path.ts'
import type { RouteHandler } from '../route.ts'

export interface RecoveryRouteStorage {
  list(): RecoverySummary[]
  get(sessionId: string, access?: { ownerId?: string }): RecoveryRecord | null
  claim(command: ClaimRecovery): RecoveryRecord
  renew(command: OwnedRecovery): void
  release(command: OwnedRecovery): void
  save(command: SaveRecovery): RecoveryRecord
  delete(command: DeleteRecovery): void
}

export function createRecoveryRoutes(recovery: RecoveryRouteStorage): RouteHandler {
  return async (req, res, url) => {
    const pathname = url.pathname
    const recoveryPath = /^\/api\/recovery\/([^/]+)$/.exec(pathname)
    const recoveryAction = /^\/api\/recovery\/([^/]+)\/(claim|heartbeat|release)$/.exec(pathname)
    if (req.method === 'GET' && pathname === '/api/recovery') {
      json(res, 200, recovery.list())
    } else if (req.method === 'GET' && recoveryPath) {
      const id = projectId(recoveryPath[1]!)
      const ownerId = z
        .uuid()
        .optional()
        .parse(url.searchParams.get('ownerId') ?? undefined)
      const record = recovery.get(id, { ownerId })
      if (!record) throw new RequestError(404, 'Копия восстановления не найдена.')
      json(res, 200, record)
    } else if (req.method === 'POST' && recoveryAction) {
      const id = projectId(recoveryAction[1]!)
      if (recoveryAction[2] === 'claim') {
        const { ownerId, expectedVersion } = recoveryClaimSchema.parse(await readJson(req))
        json(res, 200, recovery.claim({ sessionId: id, ownerId, expectedVersion }))
      } else {
        const { ownerId } = recoveryOwnerSchema.parse(await readJson(req))
        if (recoveryAction[2] === 'heartbeat') recovery.renew({ sessionId: id, ownerId })
        else recovery.release({ sessionId: id, ownerId })
        json(res, 200, { ok: true })
      }
    } else if (req.method === 'PUT' && recoveryPath) {
      const id = projectId(recoveryPath[1]!)
      const { ownerId, sourceSha256, ...transfer } = recoveryTransferSchema.parse(
        await readJson(req, MAX_LOCAL_PROJECT_BYTES + 64 * 1024),
      )
      if (transfer.sessionId !== id)
        throw new RequestError(400, 'ID копии восстановления в адресе и запросе не совпадают.')
      const record = recovery.save({ input: transfer, ownerId, sourceSha256 })
      const { scheme } = record
      json(res, 200, {
        version: record.version,
        updatedAt: record.updatedAt,
        ...(scheme.source.kind === 'legacy-html-v1'
          ? {
              sourceSha256: createHash('sha256')
                .update(scheme.source.originalJson, 'utf8')
                .digest('hex'),
            }
          : {}),
      })
    } else if (req.method === 'DELETE' && recoveryPath) {
      const id = projectId(recoveryPath[1]!)
      const { expectedVersion, ownerId } = recoveryDeleteSchema
        .extend({ ownerId: z.uuid() })
        .parse(await readJson(req))
      recovery.delete({ sessionId: id, expectedVersion, ownerId })
      json(res, 200, { deleted: true })
    } else return false
    return true
  }
}
