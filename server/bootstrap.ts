import { dirname, join } from 'node:path'
import type { Server } from 'node:http'
import { DiagnosticsLog } from './diagnostics.ts'
import { createHttpServer, DEFAULT_PORT } from './http/server.ts'
import { createServerRuntime } from './server-runtime.ts'
import { migrationNotice } from './database/migration-notice.ts'

/** API keeps its graceful close policy, distinct from desktop's forced shutdown. */
export function registerApiShutdown(
  server: Server,
  runtime: { close(): void },
  signals: { on(signal: 'SIGINT' | 'SIGTERM', listener: () => void): unknown } = process,
) {
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    signals.on(signal, () => server.close(() => runtime.close()))
  }
}

export function startApi(databasePath: string, port = DEFAULT_PORT) {
  process.umask(0o077)
  const runtime = createServerRuntime(databasePath)
  const diagnostics = new DiagnosticsLog(join(dirname(databasePath), 'diagnostics.jsonl'), {
    version: 'dev',
    mode: 'npm run dev',
  })
  const server = createHttpServer(runtime.http, port, undefined, diagnostics)
  server.listen(port, '127.0.0.1', () => {
    console.log(`Локальный редактор: http://127.0.0.1:${port}/`)
    console.log(`Реестр хранится в ${databasePath}`)
    const updated = migrationNotice(runtime)
    if (updated) console.log(updated)
  })
  registerApiShutdown(server, runtime)
  return { server, runtime }
}
