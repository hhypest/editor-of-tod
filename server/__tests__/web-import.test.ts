import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import type { Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ExcelJS from 'exceljs'
import { afterEach, describe, expect, it } from 'vitest'
import { createRegistryServer } from '../index'
import { RegistryStore } from '../store'

const servers: Server[] = []
const stores: RegistryStore[] = []
const directories: string[] = []

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  )
  for (const store of stores.splice(0)) store.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

async function workbook(roadName: string, kilometre = 88): Promise<Buffer> {
  const book = new ExcelJS.Workbook()
  const sheet = book.addWorksheet('TEST')
  sheet.getCell('A5').value = 'Карточка № 99'
  sheet.getCell('A9').value = kilometre
  sheet.getCell('D9').value = 3
  sheet.getCell('H9').value = 'Учебный участок (99999)'
  sheet.getCell('H17').value = roadName
  sheet.getCell('A45').value = '№ п/п'
  for (let item = 1; item <= 30; item++) {
    const row = 47 + item
    sheet.getCell(`A${row}`).value = item
    sheet.getCell(`B${row}`).value = `Учебное поле ${item}`
    sheet.getCell(`L${row}`).value = item + 1
  }
  return Buffer.from(await book.xlsx.writeBuffer())
}

async function readPlan(response: Response): Promise<{ fingerprint: string }> {
  const result: unknown = await response.json()
  if (
    typeof result !== 'object' ||
    result === null ||
    !('fingerprint' in result) ||
    typeof result.fingerprint !== 'string'
  ) {
    throw new Error('Preview did not return a fingerprint')
  }
  return { ...result, fingerprint: result.fingerprint }
}

describe('browser PU-66 import', () => {
  it('imports several books as one batch with one backup and rejects more than 100', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'tod-web-batch-'))
    directories.push(directory)
    const store = new RegistryStore(join(directory, 'registry.sqlite'))
    stores.push(store)
    const server = createRegistryServer(store, 0)
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Server address missing')
    const url = `http://127.0.0.1:${address.port}/api/pu66/import`
    const files = await Promise.all(
      [80, 81, 82, 83, 84].map(async (km) => ({
        name: `TEST-${km}.xlsx`,
        data: (await workbook(`Вымышленная дорога ${km}`, km)).toString('base64'),
      })),
    )
    const post = (endpoint: 'preview' | 'apply', payload: unknown) =>
      fetch(`${url}/${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1:5173' },
        body: JSON.stringify(payload),
      })
    const tooMany = Array.from({ length: 101 }, (_, index) => ({
      ...files[0]!,
      name: `X-${index}.xlsx`,
    }))
    expect((await post('preview', { files: tooMany })).status).toBe(400)
    const selected = files
    const preview = await readPlan(await post('preview', { files: selected }))
    expect(preview).toMatchObject({ added: 5, updated: 0, unchanged: 0 })
    const result = await post('apply', {
      files: selected,
      expectedFingerprint: preview.fingerprint,
    })
    expect(result.status).toBe(200)
    expect(store.listPu66()).toHaveLength(5)
    expect(readdirSync(join(directory, 'backups'))).toHaveLength(1)
  })

  it('previews without writing, requires a matching plan, and backs up before import', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'tod-web-import-'))
    directories.push(directory)
    const store = new RegistryStore(join(directory, 'registry.sqlite'))
    stores.push(store)
    const server = createRegistryServer(store, 0)
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Server address missing')
    const url = `http://127.0.0.1:${address.port}/api/pu66/import`
    const file = {
      name: 'TEST-99.xlsx',
      data: (await workbook('Вымышленная дорога')).toString('base64'),
    }
    const post = (endpoint: 'preview' | 'apply', payload: unknown, origin = true) =>
      fetch(`${url}/${endpoint}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(origin ? { Origin: 'http://127.0.0.1:5173' } : {}),
        },
        body: JSON.stringify(payload),
      })

    expect((await post('preview', { files: [file] }, false)).status).toBe(403)
    expect((await post('preview', { files: [file, file] })).status).toBe(400)
    expect((await post('preview', { files: [{ ...file, data: 'not base64' }] })).status).toBe(400)
    expect(
      (
        await post('preview', {
          files: [
            { name: 'too-large.xlsx', data: Buffer.alloc(4 * 1024 * 1024 + 1).toString('base64') },
          ],
        })
      ).status,
    ).toBe(413)

    const previewResponse = await post('preview', { files: [file] })
    expect(previewResponse.status).toBe(200)
    const preview = await readPlan(previewResponse)
    expect(preview).toMatchObject({
      added: 1,
      updated: 0,
      unchanged: 0,
      items: [{ referenceId: '99999:88:3', action: 'add', currentRevision: 0 }],
    })
    expect(JSON.stringify(preview)).not.toContain(file.data)
    expect(JSON.stringify(preview)).not.toContain('technicalRows')
    expect(store.listPu66()).toHaveLength(0)
    expect(
      (await post('apply', { files: [file], expectedFingerprint: '0'.repeat(64) })).status,
    ).toBe(409)
    expect(readdirSync(directory)).not.toContain('backups')

    const applyResponse = await post('apply', {
      files: [file],
      expectedFingerprint: preview.fingerprint,
    })
    expect(applyResponse.status).toBe(200)
    expect(await applyResponse.json()).toMatchObject({
      added: 1,
      updated: 0,
      unchanged: 0,
      backup: expect.stringMatching(/^registry-.*\.sqlite$/),
    })
    expect(readdirSync(join(directory, 'backups'))).toHaveLength(1)
    expect(store.listPu66()).toMatchObject([{ referenceId: '99999:88:3', revision: 1 }])
    expect(
      (await post('apply', { files: [file], expectedFingerprint: preview.fingerprint })).status,
    ).toBe(409)
    expect(readdirSync(join(directory, 'backups'))).toHaveLength(1)

    const unchanged = await readPlan(await post('preview', { files: [file] }))
    expect(unchanged).toMatchObject({ added: 0, updated: 0, unchanged: 1 })
    expect(
      await (
        await post('apply', { files: [file], expectedFingerprint: unchanged.fingerprint })
      ).json(),
    ).toMatchObject({ added: 0, updated: 0, unchanged: 1, backup: null })
    expect(readdirSync(join(directory, 'backups'))).toHaveLength(1)

    const changed = {
      ...file,
      data: (await workbook('Обновлённая вымышленная дорога')).toString('base64'),
    }
    const changedPlan = await readPlan(await post('preview', { files: [changed] }))
    expect(changedPlan).toMatchObject({
      updated: 1,
      items: [{ action: 'update', currentRevision: 1 }],
    })
    expect(
      (await post('apply', { files: [changed], expectedFingerprint: changedPlan.fingerprint }))
        .status,
    ).toBe(200)
    expect(store.listPu66()).toMatchObject([{ revision: 2, verification: null }])
    expect(readdirSync(join(directory, 'backups'))).toHaveLength(2)
  })
})
