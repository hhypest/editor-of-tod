import assert from 'node:assert/strict'
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
  console.log('Локальный API и CLI импортируются и запускаются напрямую через Node.js.')
} finally {
  if (server.listening) {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()))
    })
  }
  store.close()
}
