export type LocalApiErrorCode =
  | 'revision-conflict'
  | 'validation-error'
  | 'database-unavailable'
  | 'not-found'
  | 'invalid-response'
  | 'unexpected'

/** Coded client-adapter failure; user text remains separate from the machine-readable code. */
export class LocalApiError extends Error {
  constructor(
    readonly code: LocalApiErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'LocalApiError'
  }
}

export function localApiErrorForStatus(status: number, message: string): LocalApiError {
  const code: LocalApiErrorCode =
    status === 409
      ? 'revision-conflict'
      : status === 400 || status === 422
        ? 'validation-error'
        : status === 404
          ? 'not-found'
          : status === 503
            ? 'database-unavailable'
            : 'unexpected'
  return new LocalApiError(code, message)
}

export function unavailableLocalApi(message: string): LocalApiError {
  return new LocalApiError('database-unavailable', message)
}

export function invalidLocalApiResponse(message: string): LocalApiError {
  return new LocalApiError('invalid-response', message)
}

/** One UI-facing classifier, including the existing revision workflow and legacy text boundary. */
export function localApiErrorCode(cause: unknown): LocalApiErrorCode {
  if (cause instanceof LocalApiError) return cause.code
  if (typeof cause === 'object' && cause !== null && 'code' in cause) {
    switch (cause.code) {
      case 'conflict':
      case 'revision-conflict':
        return 'revision-conflict'
      case 'unavailable':
      case 'database-unavailable':
        return 'database-unavailable'
      case 'validation-error':
        return 'validation-error'
      case 'not-found':
        return 'not-found'
      case 'invalid-response':
        return 'invalid-response'
    }
  }
  // Compatibility belongs to the service boundary, not to Vue components or composables.
  if (cause instanceof Error && cause.message.includes('Запись изменилась'))
    return 'revision-conflict'
  return 'unexpected'
}
