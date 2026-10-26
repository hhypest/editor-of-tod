import type { ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RequestError } from './request-error.ts'

/** Источник файлов собранного интерфейса: папка `dist/` или ресурсы исполняемого файла. */
export type StaticFiles = (filename: string) => Promise<Buffer>

export function directoryFiles(directory: string): StaticFiles {
  return (filename) => readFile(join(directory, filename))
}

export function defaultStaticFiles(): StaticFiles {
  return directoryFiles(fileURLToPath(new URL('../../dist/', import.meta.url)))
}

/** Сведения о лицензиях сторонних компонентов из сборки интерфейса (раздел «О программе»). */
const LEGAL_FILES = new Set(['/legal/THIRD_PARTY_LICENSES.txt', '/legal/third-party.json'])

export async function serveBuiltApp(
  pathname: string,
  res: ServerResponse,
  staticFiles: StaticFiles,
): Promise<void> {
  const filename =
    pathname === '/' || pathname === '/index.html'
      ? 'index.html'
      : pathname === '/favicon.svg' ||
          /^\/assets\/[a-zA-Z0-9._-]+$/.test(pathname) ||
          LEGAL_FILES.has(pathname)
        ? pathname.slice(1)
        : null
  if (!filename) throw new RequestError(404, 'Страница не найдена.')
  try {
    const body = await staticFiles(filename)
    const type = {
      '.html': 'text/html',
      '.js': 'text/javascript',
      '.css': 'text/css',
      '.svg': 'image/svg+xml',
      '.txt': 'text/plain',
      '.json': 'application/json',
    }[extname(filename)]
    if (!type) throw new RequestError(404, 'Файл не найден.')
    res.writeHead(200, {
      'Content-Type': `${type}; charset=utf-8`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
    })
    res.end(body)
  } catch (error) {
    if (error instanceof RequestError) throw error
    throw new RequestError(
      404,
      'Файлы интерфейса не найдены. Переустановите программу и повторите запуск.',
    )
  }
}
