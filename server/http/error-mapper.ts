import type { ServerResponse } from 'node:http'
import { ZodError } from 'zod'
import type { DiagnosticsLog } from '../diagnostics.ts'
import type { ParameterRejectionReason } from '../../src/domain/normative-parameters.ts'
import { RevisionConflict, RecoveryOwned, ProjectTooLarge } from '../storage-errors.ts'
import {
  AmbiguousPu66Key,
  InvalidPu66Verification,
  InvalidPu66Lifecycle,
  InvalidPu66Upload,
} from '../pu66/errors.ts'
import { DocumentInUse } from '../documents/errors.ts'
import { InvalidSignUpload } from '../sign-web-import.ts'
import { InvalidDocumentUpload } from '../document-web-import.ts'
import { InvalidParameter, ParameterConfirmationConflict } from '../normative-parameters.ts'
import { RequestError } from './request-error.ts'
import { json } from './json.ts'

export interface ParameterRejection {
  parameterId: string
  rejectionReason: ParameterRejectionReason
}

export function parameterRejection(
  error: unknown,
  parameterId: string | undefined,
): ParameterRejection | undefined {
  if (
    (error instanceof InvalidParameter || error instanceof ParameterConfirmationConflict) &&
    parameterId
  )
    return { parameterId, rejectionReason: error.reason }
}

export function writeHttpError(
  res: ServerResponse,
  error: unknown,
  route: string,
  diagnostics: Pick<DiagnosticsLog, 'serverError'>,
): void {
  if (error instanceof RequestError) json(res, error.status, { error: error.message })
  else if (error instanceof ParameterConfirmationConflict)
    json(res, 409, { error: error.message, reason: error.reason, field: error.field })
  else if (
    error instanceof RevisionConflict ||
    error instanceof AmbiguousPu66Key ||
    error instanceof RecoveryOwned
  )
    json(res, 409, { error: error.message })
  else if (error instanceof InvalidPu66Verification || error instanceof InvalidPu66Lifecycle)
    json(res, 400, { error: error.message })
  else if (error instanceof InvalidPu66Upload) json(res, error.status, { error: error.message })
  else if (error instanceof InvalidSignUpload) json(res, error.status, { error: error.message })
  else if (error instanceof InvalidDocumentUpload) json(res, error.status, { error: error.message })
  else if (error instanceof DocumentInUse) json(res, 409, { error: error.message })
  else if (error instanceof InvalidParameter)
    json(res, error.status, { error: error.message, reason: error.reason, field: error.field })
  else if (error instanceof ProjectTooLarge) json(res, 413, { error: error.message })
  else if (error instanceof ZodError) {
    const issue = error.issues[0]
    json(res, 400, { error: `Неверное поле «${issue?.path.join('.') || 'запись'}».` })
  } else {
    json(res, 500, { error: 'Внутренняя ошибка локального реестра.' })
    diagnostics.serverError(route, error)
    console.error('Ошибка локального реестра:', error)
  }
}
