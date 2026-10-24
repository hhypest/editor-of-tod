/** Do not expose HTML proxy bodies or let their parse errors leak into the UI. */
export async function localJson(response: Response): Promise<unknown> {
  const contentType = response.headers.get('Content-Type') ?? ''
  if (!/^application\/(?:[a-z0-9.+-]*\+)?json\b/i.test(contentType)) {
    throw new Error('Программа получила неожиданный ответ. Перезапустите её и повторите действие.')
  }
  try {
    return await response.json()
  } catch {
    throw new Error('Не удалось прочитать ответ программы. Перезапустите её и повторите действие.')
  }
}
