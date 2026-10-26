import { request, type IncomingHttpHeaders, type Server } from 'node:http'

export interface HttpResponse {
  status: number
  headers: IncomingHttpHeaders
  body: Buffer
}

/** Raw HTTP avoids fetch's URL normalization and automatic content-type headers. */
export async function listenHttp(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing test server address')
  const port = address.port
  return {
    port,
    send(
      path: string,
      options: { method?: string; headers?: Record<string, string>; body?: string } = {},
    ): Promise<HttpResponse> {
      return new Promise((resolve, reject) => {
        const req = request(
          { hostname: '127.0.0.1', port, path, ...options, agent: false },
          (res) => {
            const chunks: Buffer[] = []
            res.on('data', (chunk: Buffer) => chunks.push(chunk))
            res.on('error', reject)
            res.on('end', () =>
              resolve({
                status: res.statusCode!,
                headers: res.headers,
                body: Buffer.concat(chunks),
              }),
            )
          },
        )
        req.on('error', reject)
        req.end(options.body)
      })
    },
  }
}
