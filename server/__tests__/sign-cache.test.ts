import type { Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { zipSync } from 'fflate'
import { PNG } from 'pngjs'
import { createRegistryServer } from '../index'
import { parseSignArchive } from '../signs'
import { RegistryStore } from '../store'

const servers: Server[] = []
const stores: RegistryStore[] = []
afterEach(async () => {
  for (const server of servers.splice(0))
    await new Promise<void>((resolve) => server.close(() => resolve()))
  for (const store of stores.splice(0)) store.close()
})

async function catalog(value: number) {
  const image = new PNG({ width: 8, height: 8 })
  image.data.fill(value)
  const png = PNG.sync.write(image)
  const store = new RegistryStore(':memory:')
  stores.push(store)
  store.importSigns(
    parseSignArchive(
      Buffer.from(
        zipSync({
          'PNG с номером/1.25.png': png,
          'PNG без номера/1.25.png': png,
        }),
      ),
    ),
  )
  const server = createRegistryServer(store, 0)
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Server address missing')
  return { url: `http://127.0.0.1:${address.port}/api/signs/1.25/image`, png }
}

describe('sign images are revalidated by content, including pinned revisions', () => {
  it('returns 304 only for matching bytes and fresh images after a database replacement', async () => {
    const original = await catalog(255)
    const restored = await catalog(128)
    for (const suffix of ['', '?rev=1', '?rev=1&numbered=1']) {
      const response = await fetch(original.url + suffix)
      const etag = response.headers.get('etag')!
      expect(etag).toMatch(/^"[a-f0-9]{64}"$/)
      expect(response.headers.get('cache-control')).toBe('private, no-cache')
      expect(Buffer.from(await response.arrayBuffer())).toEqual(original.png)
      const cached = await fetch(original.url + suffix, {
        headers: { 'If-None-Match': `W/${etag}` },
      })
      expect(cached.status).toBe(304)
      expect(await cached.text()).toBe('')
      const changed = await fetch(restored.url + suffix, { headers: { 'If-None-Match': etag } })
      expect(changed.status).toBe(200)
      expect(changed.headers.get('etag')).not.toBe(etag)
      expect(Buffer.from(await changed.arrayBuffer())).toEqual(restored.png)
    }
  })
})
