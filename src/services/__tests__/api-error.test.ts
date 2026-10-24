import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProjectRevisionError } from '../../application/project-revisions'
import { diagnosticError } from '../../shared/diagnostic-data'
import { LocalApiError, localApiErrorCode, localApiErrorForStatus } from '../api-error'
import { listLocalProjects } from '../local-projects'

afterEach(() => vi.unstubAllGlobals())

describe('local API error contracts', () => {
  it.each([
    [409, 'revision-conflict'],
    [400, 'validation-error'],
    [422, 'validation-error'],
    [404, 'not-found'],
    [503, 'database-unavailable'],
    [500, 'unexpected'],
  ] as const)('classifies HTTP %s as %s', (status, code) => {
    const error = localApiErrorForStatus(status, 'Сообщение для составителя')
    expect(error).toBeInstanceOf(LocalApiError)
    expect(error.code).toBe(code)
    expect(error.message).toBe('Сообщение для составителя')
  })

  it('uses one classifier for revision, local API and legacy boundary errors', () => {
    expect(localApiErrorCode(new ProjectRevisionError('conflict', 'Конфликт'))).toBe(
      'revision-conflict',
    )
    expect(localApiErrorCode(new ProjectRevisionError('unavailable', 'Нет связи'))).toBe(
      'database-unavailable',
    )
    expect(localApiErrorCode(new ProjectRevisionError('failed', 'Ошибка'))).toBe('unexpected')
    expect(localApiErrorCode(new LocalApiError('invalid-response', 'Ошибка'))).toBe(
      'invalid-response',
    )
    expect(localApiErrorCode(new Error('Запись изменилась в другом окне.'))).toBe(
      'revision-conflict',
    )
    expect(localApiErrorCode(new Error('Другая ошибка'))).toBe('unexpected')
  })

  it('keeps sensitive response text out of diagnostic payloads', () => {
    const secret = 'Учебный переезд.xlsx C:\\Рабочие\\Учебный.sqlite'
    const report = diagnosticError(new LocalApiError('unexpected', secret))
    expect(report.errorType).toBe('Error')
    expect(JSON.stringify(report)).not.toContain(secret)
  })

  it('returns coded network, response and HTTP failures from the project adapter', async () => {
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    fetcher.mockRejectedValueOnce(new TypeError('network'))
    await expect(listLocalProjects()).rejects.toMatchObject({
      name: 'LocalApiError',
      code: 'database-unavailable',
    })
    fetcher.mockResolvedValueOnce(new Response('<html>proxy</html>', { status: 502 }))
    await expect(listLocalProjects()).rejects.toMatchObject({
      name: 'LocalApiError',
      code: 'invalid-response',
    })
    fetcher.mockResolvedValueOnce(
      Response.json({ error: 'Запись изменилась в другом окне.' }, { status: 409 }),
    )
    await expect(listLocalProjects()).rejects.toMatchObject({
      name: 'LocalApiError',
      code: 'revision-conflict',
    })
    expect(fetcher).toHaveBeenCalledTimes(3)
  })
})
