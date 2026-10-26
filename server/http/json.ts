import type { IncomingMessage, ServerResponse } from 'node:http'
import { RequestError } from './request-error.ts'

export function json(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  res.end(JSON.stringify(data))
}

export async function readJson(req: IncomingMessage, maxBytes = 64 * 1024): Promise<unknown> {
  if (!req.headers['content-type']?.startsWith('application/json')) {
    throw new RequestError(
      415,
      'Программа не смогла выполнить действие. Перезапустите её и повторите.',
    )
  }
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.length
    if (size > maxBytes)
      throw new RequestError(
        413,
        'Слишком много данных для одного действия. Скачайте файл проекта, перезапустите программу и повторите.',
      )
    chunks.push(bytes)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new RequestError(
      400,
      'Программа не смогла прочитать данные. Перезапустите её и повторите действие.',
    )
  }
}
