import { afterEach, describe, expect, it, vi } from 'vitest'
import { flush, reportError, timed } from '../diagnostics'

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

  it('keeps the text only when explicitly allowed for code errors', async () => {
    const bodies = captureRequests()
    reportError('Операция с локальной базой', new Error('Карточка ст.Учебная:1:1'), {
      withText: false,
    })
    reportError('Ошибка Vue (render)', new TypeError('x is undefined'))
    await flush()
    const sent = bodies.join('\n')
    expect(sent).not.toContain('Учебная')
    expect(sent).toContain('x is undefined')
  })
})
