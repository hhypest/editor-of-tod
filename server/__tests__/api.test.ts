import { afterEach, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import { readFileSync } from 'node:fs'
import { zipSync } from 'fflate'
import { PNG } from 'pngjs'
import { importSchemeJson } from '../../src/domain/import'
import { projectRecordSchema, projectSummarySchema } from '../../src/domain/local-projects'
import { createRegistryServer } from '../index'
import { extractPu66Cells } from '../pu66'
import { parseSignArchive } from '../signs'
import { RegistryStore } from '../store'

const servers: Server[] = []
const stores: RegistryStore[] = []
const fixture = readFileSync(
  new URL('../../tests/fixtures/manual-v1.json', import.meta.url),
  'utf8',
)
afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  )
  for (const store of stores.splice(0)) store.close()
})

describe('local API', () => {
  it('returns only versioned scheme fields from a synthetic PU-66 card', async () => {
    const values = new Map<string, string | number>([
      ['A5', 'Карточка № 99'],
      ['A9', 88],
      ['D9', 3],
      ['H9', 'Учебный участок (99999)'],
      ['H17', 'Вымышленная дорога'],
      ['A45', '№ п/п'],
    ])
    for (let item = 1; item <= 30; item++) {
      values.set(`A${47 + item}`, item)
      values.set(`B${47 + item}`, `Учебное поле ${item}`)
      values.set(`L${47 + item}`, item + 1)
    }
    const card = extractPu66Cells((address) => values.get(address) ?? null)
    const store = new RegistryStore(':memory:')
    store.importPu66([
      {
        card,
        source: Buffer.from('synthetic bytes'),
        sha256: 'a'.repeat(64),
        filename: 'TEST-99.xlsx',
      },
    ])
    stores.push(store)
    const server = createRegistryServer(store, 0)
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Server address missing')
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/pu66/${encodeURIComponent(card.key)}/scheme`,
    )
    expect(response.status).toBe(200)
    const selected = await response.json()
    expect(selected).toEqual({
      referenceId: '99999:88:3',
      location: '88 км 3 пк',
      axisLabel: '88 км 3 пк',
      roadName: 'Вымышленная дорога',
      crossingWidthMetres: 8,
      revision: 1,
      updatedAt: expect.any(String),
    })
    expect(JSON.stringify(selected)).not.toContain('technicalRows')
  })

  it('serves both PNG sign variants and rejects the removed SVG format', async () => {
    const plain = new PNG({ width: 8, height: 8 })
    plain.data.fill(255)
    const numbered = new PNG({ width: 8, height: 8 })
    numbered.data.fill(128)
    const plainPng = PNG.sync.write(plain)
    const numberedPng = PNG.sync.write(numbered)
    const archive = Buffer.from(
      zipSync({ 'PNG с номером/1.1_ж.png': numberedPng, 'PNG без номера/1.1_ж.png': plainPng }),
    )
    const store = new RegistryStore(':memory:')
    store.importSigns(parseSignArchive(archive))
    stores.push(store)
    const server = createRegistryServer(store, 0)
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Server address missing')
    const url = `http://127.0.0.1:${address.port}/api/signs/1.1_%D0%B6/image`
    for (const [suffix, expectedPng] of [
      ['', plainPng],
      ['?format=png&numbered=1', numberedPng],
    ] as const) {
      const response = await fetch(url + suffix)
      expect(response.status).toBe(200)
      expect(response.headers.get('Content-Type')).toBe('image/png')
      expect(Buffer.from(await response.arrayBuffer())).toEqual(expectedPng)
    }
    expect((await fetch(url + '?format=svg')).status).toBe(400)
  })

  it('accepts a same-origin write and rejects missing origin, invalid input, and stale revisions', async () => {
    const store = new RegistryStore(':memory:')
    stores.push(store)
    const server = createRegistryServer(store, 0)
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Server address missing')
    const url = `http://127.0.0.1:${address.port}`
    const entry = {
      referenceId: 'TEST-003',
      railwayLocation: 'Учебный участок',
      roadName: '',
      roadOwner: '',
      cardReference: '',
      cardUpdatedAt: '',
      verifiedAt: '',
      notes: '',
      expectedRevision: 0,
    }
    const options = {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1:5173' },
      body: JSON.stringify(entry),
    }
    expect(
      (
        await fetch(`${url}/api/crossings`, {
          ...options,
          headers: { 'Content-Type': 'application/json' },
        })
      ).status,
    ).toBe(403)
    expect(
      (
        await fetch(`${url}/api/crossings`, {
          ...options,
          body: JSON.stringify({ ...entry, verifiedAt: 'не дата' }),
        })
      ).status,
    ).toBe(400)
    expect((await fetch(`${url}/api/crossings`, options)).status).toBe(200)
    expect((await fetch(`${url}/api/crossings`, options)).status).toBe(409)
    const rows = await (await fetch(`${url}/api/crossings`)).json()
    expect(rows).toMatchObject([{ referenceId: 'TEST-003', revision: 1 }])
  })

  it('saves local project snapshots through the API and restores a prior revision safely', async () => {
    const store = new RegistryStore(':memory:')
    stores.push(store)
    const server = createRegistryServer(store, 0)
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Server address missing')
    const url = `http://127.0.0.1:${address.port}`
    const scheme = importSchemeJson(fixture).scheme
    const path = `${url}/api/projects/${scheme.id}`
    const write = (payload: unknown, includeOrigin = true) =>
      fetch(path, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          ...(includeOrigin ? { Origin: 'http://127.0.0.1:5173' } : {}),
        },
        body: JSON.stringify(payload),
      })

    expect((await write({ scheme, expectedRevision: 0 }, false)).status).toBe(403)
    expect((await write({ scheme, expectedRevision: 0 }, true)).status).toBe(200)
    const longSource = {
      ...scheme,
      source: { ...scheme.source, originalJson: fixture + ' '.repeat(70_000) },
    }
    const updated = await write({ scheme: longSource, expectedRevision: 1 })
    expect(updated.status).toBe(200)
    expect(projectRecordSchema.parse(await updated.json()).revision).toBe(2)
    expect((await write({ scheme, expectedRevision: 1 })).status).toBe(409)
    expect((await fetch(`${url}/api/projects`)).status).toBe(200)
    const summaries = projectSummarySchema
      .array()
      .parse(await (await fetch(`${url}/api/projects`)).json())
    expect(summaries).toMatchObject([{ id: scheme.id, referenceId: 'TEST-001', revision: 2 }])
    expect(JSON.stringify(summaries)).not.toContain('originalJson')
    const revisions = await (await fetch(`${path}/revisions`)).json()
    expect(revisions).toHaveLength(2)
    const old = projectRecordSchema.parse(await (await fetch(`${path}/revisions/1`)).json())
    expect(old.scheme.source).toMatchObject({ originalJson: fixture })
    const restore = await fetch(`${path}/restore`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1:5173' },
      body: JSON.stringify({ sourceRevision: 1, expectedRevision: 2 }),
    })
    expect(restore.status).toBe(200)
    expect(projectRecordSchema.parse(await restore.json()).revision).toBe(3)
    expect(projectRecordSchema.parse(await (await fetch(path)).json()).scheme.source).toMatchObject(
      {
        originalJson: fixture,
      },
    )
    expect(
      (await write({ scheme: { ...scheme, id: crypto.randomUUID() }, expectedRevision: 3 })).status,
    ).toBe(400)
  })
})
