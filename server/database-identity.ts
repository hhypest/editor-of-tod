import { createHash, randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'

/** Различает локальные базы без передачи пути в браузер или другому экземпляру программы. */
export function databaseIdentity(path: string): string {
  const canonical = path === ':memory:' ? randomUUID() : realpathSync(path)
  return createHash('sha256')
    .update(process.platform === 'win32' ? canonical.toLowerCase() : canonical)
    .digest('hex')
}
