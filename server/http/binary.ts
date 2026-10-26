import type { IncomingMessage, ServerResponse } from 'node:http'
import { createHash } from 'node:crypto'

export function sendPdf(res: ServerResponse, file: { filename: string; pdf: Uint8Array }): void {
  res.writeHead(200, {
    'Content-Type': 'application/pdf',
    'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
  })
  res.end(Buffer.from(file.pdf))
}

export function sendPng(res: ServerResponse, png: Uint8Array): void {
  res.writeHead(200, {
    'Content-Type': 'image/png',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Content-Security-Policy': "default-src 'none'; sandbox",
  })
  res.end(png)
}

export function sendCachedPng(req: IncomingMessage, res: ServerResponse, asset: Uint8Array): void {
  const etag = `"${createHash('sha256').update(asset).digest('hex')}"`
  const unchanged = (req.headers['if-none-match'] ?? '')
    .split(',')
    .some((value) => value.trim().replace(/^W\//, '') === etag || value.trim() === '*')
  res.writeHead(unchanged ? 304 : 200, {
    'Content-Type': 'image/png',
    'Cache-Control': 'private, no-cache',
    ETag: etag,
    'X-Content-Type-Options': 'nosniff',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Content-Security-Policy': "default-src 'none'; sandbox",
  })
  res.end(unchanged ? undefined : asset)
}
