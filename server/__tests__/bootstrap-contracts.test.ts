import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { zipSync } from 'fflate'
import { createSampleWorkbook, sampleCards } from '../../scripts/generate-pu66-samples'
import { launchDesktop } from '../desktop-instance'
import { runImport } from '../import-cli'
import { RegistryStore } from '../store'
import { catalogEntry } from './sign-catalog-fixture'

const directories: string[] = [],
  stores: RegistryStore[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const store of stores.splice(0)) store.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})
function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'tod-bootstrap-contract-'))
  directories.push(directory)
  const store = new RegistryStore(join(directory, 'registry.sqlite'))
  stores.push(store)
  return { directory, store }
}

/** Compatibility checks run before the production bootstrap stops using RegistryStore. */
describe('production bootstrap/import compatibility', () => {
  it('keeps PU-66 CLI preview, apply/backup and unchanged no-op on the same connection', async () => {
    const { directory, store } = setup(),
      file = join(directory, 'fictional.xlsx')
    writeFileSync(file, await createSampleWorkbook(sampleCards[1]!))
    const backup = vi.spyOn(store, 'createBackup')
    expect(await runImport(['pu66', file], store)).toContain('новых 1')
    expect(store.listPu66()).toEqual([])
    expect(backup).not.toHaveBeenCalled()
    expect(await runImport(['pu66', '--apply', file], store)).toContain('добавлено 1')
    expect(store.listPu66()).toHaveLength(1)
    expect(backup).toHaveBeenCalledTimes(1)
    expect(await runImport(['pu66', '--apply', file], store)).toBe(
      'ПУ-66: данные уже загружены, изменений нет.',
    )
    expect(backup).toHaveBeenCalledTimes(1)
    expect(readdirSync(store.backupDirectory)).toHaveLength(1)
  })

  it('keeps sign CLI preview and prevents writes if backup fails', async () => {
    const { directory, store } = setup(),
      file = join(directory, 'fictional.zip')
    const entry = catalogEntry()
    writeFileSync(
      file,
      zipSync({
        'PNG с номером/1.25.png': entry.numberedPng,
        'PNG без номера/1.25.png': entry.plainPng,
      }),
    )
    expect(await runImport(['signs', file], store)).toContain('новых 1')
    const failure = new Error('fictional backup failure')
    vi.spyOn(store, 'createBackup').mockRejectedValue(failure)
    await expect(runImport(['signs', '--apply', file], store)).rejects.toBe(failure)
    expect(store.latestSignCatalog()).toBeNull()
    expect(store.listSigns()).toEqual([])
  })

  it('closes the opened connection and releases the launch lock after an unexpected listen failure', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'tod-bootstrap-failure-'))
    directories.push(directory)
    const path = join(directory, 'registry.sqlite'),
      failure = Object.assign(new Error('fictional listen failure'), { code: 'EIO' })
    const close = vi.spyOn(DatabaseSync.prototype, 'close')
    vi.spyOn(Server.prototype, 'listen').mockImplementationOnce(function (this: Server) {
      queueMicrotask(() => this.emit('error', failure))
      return this
    })
    await expect(launchDesktop(path, 0)).rejects.toBe(failure)
    expect(close).toHaveBeenCalledTimes(1)
    expect(readdirSync(directory)).not.toContain('registry.sqlite.launch.lock')
    expect(readdirSync(directory)).not.toContain('registry.sqlite.instance.json')
    const reopened = new RegistryStore(path)
    stores.push(reopened)
    expect(reopened.schemaVersion()).toBe(13)
  })
})
