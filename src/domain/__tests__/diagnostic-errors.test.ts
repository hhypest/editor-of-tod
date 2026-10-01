import { describe, expect, it } from 'vitest'
import { describeDiagnosticError, sanitizeErrorDescription } from '../diagnostic-errors'

describe('safe diagnostic error descriptions', () => {
  it('retains code positions after client and server sanitization without absolute paths', () => {
    const error = new TypeError('Станция-Синтетическая /home/test/private/книга.xlsx')
    error.stack = `TypeError: ${error.message}\n    at render (http://127.0.0.1:4100/assets/index-abc123.js:20:30)\nload@file:///home/test/src/services/diagnostics.ts:40:50\n    at /home/test/private/книга.xlsx:1:2`
    const clean = describeDiagnosticError(error)
    expect(clean).toBe('TypeError\nat assets/index.js:20:30\nat src/services/diagnostics.ts:40:50')
    expect(sanitizeErrorDescription(clean)).toBe(clean)
  })

  it('never includes custom exception names, non-Error values or unknown filenames', () => {
    const error = new Error('Тестовая-книга.xlsx')
    error.name = 'Станция-Синтетическая'
    error.stack = 'Станция-Синтетическая\n    at /srv/private/станция.ts:10:20'
    expect(describeDiagnosticError(error)).toBe('Error')
    expect(describeDiagnosticError('Тестовая-книга.xlsx')).toBe('Error')
  })
})
