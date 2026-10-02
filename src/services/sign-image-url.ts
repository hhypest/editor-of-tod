/** Новый адрес обходит старые ответы с годовым immutable-кэшем; дальше сервер сверяет ETag. */
export function signImageUrl(code: string, revision?: number): string {
  return `/api/signs/${encodeURIComponent(code)}/image?cache=2${revision ? `&rev=${revision}` : ''}`
}
