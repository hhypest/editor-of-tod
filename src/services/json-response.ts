/** Do not expose HTML proxy bodies or let their parse errors leak into the UI. */
export async function localJson(response: Response): Promise<unknown> {
  const contentType = response.headers.get('Content-Type') ?? ''
  if (!/^application\/(?:[a-z0-9.+-]*\+)?json\b/i.test(contentType)) {
    throw new Error('Локальный API вернул не JSON. Проверьте, что запущены API и интерфейс.')
  }
  try {
    return await response.json()
  } catch {
    throw new Error('Локальный API вернул повреждённый JSON. Перезапустите приложение.')
  }
}
