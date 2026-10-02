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

  it('omits text and private stack paths for code errors too', async () => {
    const bodies = captureRequests()
    const error = new TypeError('Учебная станция.xlsx C:\\Рабочие\\данные /srv/private')
    error.stack = `${error.message}\n at ФункцияУчебная (http://127.0.0.1:5173/src/App.vue:11:3)\n at ФункцияУчебная (/srv/private/Учебная.ts:22:1)`
    reportError('Ошибка Vue (render)', error)
    reportError('Операция с локальной базой', new Error('Карточка ст.Учебная:1:1'))
    await flush()
    const sent = bodies.join('\n')
    for (const secret of ['Учебная', '.xlsx', 'Рабочие', '/srv/private', 'Функция', '127.0.0.1'])
      expect(sent).not.toContain(secret)
    expect(sent).toContain('TypeError')
    expect(sent).toContain('src/App.vue:11:3')
    expect(sent).not.toContain('"message"')
  })
})
