import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchDesktop } from '../server/desktop-instance.ts'
import { createRegistryServer } from '../server/index.ts'
import { runImport } from '../server/import-cli.ts'
import { RegistryStore } from '../server/store.ts'

const store = new RegistryStore(':memory:')
const server = createRegistryServer(store, 0)

try {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const response = await fetch(`http://127.0.0.1:${address.port}/api/status`)
  assert.equal(response.status, 200)
  const status = await response.json()
  assert.equal(status.ready, true)
  assert.equal(status.application, 'editor-of-tod')
  assert.match(status.databaseId, /^[a-f0-9]{64}$/)
  assert.equal(typeof runImport, 'function')

  // Запуск программы (`npm run desktop`, exe): второй запуск находит первый и не открывает базу.
  const directory = mkdtempSync(join(tmpdir(), 'tod-check-desktop-'))
  const databasePath = join(directory, 'registry.sqlite')
  const first = await launchDesktop(databasePath, address.port + 1)
  try {
    assert.equal(first.running, false)
    assert.ok(existsSync(`${databasePath}.instance.json`))
    assert.deepEqual(await launchDesktop(databasePath, address.port + 1), {
      running: true,
      port: first.port,
    })
  } finally {
    if (!first.running) {
      first.release()
      await new Promise((resolve) => first.server.close(resolve))
      first.store.close()
    }
    rmSync(directory, { recursive: true, force: true })
  }
  console.log('Локальный API, CLI и запуск программы работают напрямую через Node.js.')
} finally {
  if (server.listening) {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()))
    })
  }
  store.close()
}
