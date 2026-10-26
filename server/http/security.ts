import type { IncomingMessage } from 'node:http'
import { RequestError } from './request-error.ts'

export function checkRequest(req: IncomingMessage, listenPort: number): void {
  const host = req.headers.host
  if (host !== `127.0.0.1:${listenPort}` && host !== `localhost:${listenPort}`) {
    throw new RequestError(403, 'Допускается только локальное обращение.')
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const allowed = [
      `http://127.0.0.1:${listenPort}`,
      `http://localhost:${listenPort}`,
      'http://127.0.0.1:5173',
      'http://localhost:5173',
      'http://127.0.0.1:4173',
      'http://localhost:4173',
    ]
    if (!req.headers.origin || !allowed.includes(req.headers.origin)) {
      throw new RequestError(403, 'Запись доступна только из локального интерфейса.')
    }
  }
}
