import { afterEach, describe, expect, it, vi } from 'vitest'
import { flush, installDiagnostics, reportError, timed } from '../diagnostics'

afterEach(() => vi.unstubAllGlobals())

function captureRequests(): string[] {
  const bodies: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: { body?: string }) => {
      bodies.push(init?.body ?? '')
      return new Response('{}')
    }),
  )
  return bodies
}

describe('client diagnostics never log the text of file operation errors', () => {
  it('records the failed operation, its type and duration but not the file name', async () => {
    const bodies = captureRequests()
    await expect(
      timed('Импорт ПУ-66', () =>
        Promise.reject(
          new Error('Не удалось прочитать выбранный файл Переезд Учебная станция.xlsx.'),
        ),
      ),
    ).rejects.toThrow('Учебная станция')
    await flush()
    const sent = bodies.join('\n')
    expect(sent).toContain('Импорт ПУ-66')
    expect(sent).toContain('"kind":"error"')
    expect(sent).toContain('durationMs')
    expect(sent).not.toContain('Учебная')
    expect(sent).not.toContain('.xlsx')
  })

  it('removes text and absolute paths for global window, rejection and Vue errors', async () => {
    const bodies = captureRequests()
    const listeners = new Map<string, (event: unknown) => void>()
    vi.stubGlobal('window', {
      addEventListener: (name: string, callback: (event: unknown) => void) =>
        listeners.set(name, callback),
    })
    const app = { config: { errorHandler: undefined as unknown } }
    installDiagnostics(app as Parameters<typeof installDiagnostics>[0])
    const error = new TypeError('Станция-Синтетическая /srv/private/Тестовая-книга.xlsx')
    error.stack = `${error.name}: ${error.message}\n    at render (C:\\Данные\\src\\components\\App.vue:10:20)\n    at /srv/private/Тестовая-книга.xlsx:30:40\n    at load (/srv/private/src/services/diagnostics.ts:50:60)`
    listeners.get('error')!({ error })
    listeners.get('unhandledrejection')!({ reason: error })
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      ;(app.config.errorHandler as (error: unknown) => void)(error)
      reportError('Операция с локальной базой', error)
      await flush()
      const sent = bodies.join('\n')
      for (const secret of [
        'Станция-Синтетическая',
        'Тестовая-книга.xlsx',
        '/srv/private',
        'Данные',
      ])
        expect(sent).not.toContain(secret)
      expect(sent).toContain('TypeError')
      expect(sent).toContain('src/services/diagnostics.ts:50:60')
      expect(sent).toContain('Ошибка Vue')
    } finally {
      consoleError.mockRestore()
    }
  })
})
