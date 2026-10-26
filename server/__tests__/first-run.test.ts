import { openTestApplication } from './test-application'
import { mkdtempSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { zipSync } from 'fflate'
import { PNG } from 'pngjs'
import { createSampleWorkbook, sampleCards } from '../../scripts/generate-pu66-samples.ts'
import { parsePu66 } from '../pu66.ts'

import { applyPu66Upload, previewPu66Upload } from '../pu66-web-import.ts'
import { applySignUpload, previewSignUpload } from '../sign-web-import.ts'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('first launch with synthetic source files', () => {
  it('creates an empty local SQLite, imports four distinct PU-66 layouts and a local sign ZIP', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'tod-first-run-'))
    directories.push(directory)
    const database = join(directory, 'private-data', 'registry.sqlite')
    expect(existsSync(database)).toBe(false)

    const store = openTestApplication(database)
    try {
      expect(existsSync(database)).toBe(true)
      expect(store.pu66.list()).toHaveLength(0)
      expect(store.signCatalog.list()).toHaveLength(0)
      expect(store.legacy.listNormative()).toHaveLength(4)

      const files = await Promise.all(
        sampleCards.slice(0, 4).map(async (sample) => {
          const bytes = await createSampleWorkbook(sample)
          const parsed = await parsePu66(bytes, sample.filename)
          expect(parsed.card).toMatchObject({
            kilometre: sample.kilometre,
            picket: sample.picket,
            roadName: sample.road,
            section: sample.section,
          })
          expect(parsed.card.technicalRows.find((row) => row.item === '7')?.current).toBe(
            sample.width,
          )
          expect(parsed.card.technicalRows.find((row) => row.item === '8')?.current).toBe(
            sample.length,
          )
          expect(parsed.card.technicalRows.find((row) => row.item === '30')).toBeDefined()
          return { name: sample.filename, data: bytes.toString('base64') }
        }),
      )
      const pu66Plan = await previewPu66Upload(store.runtime.http.pu66.importCommands, { files })
      expect(pu66Plan).toMatchObject({ added: 4, updated: 0, unchanged: 0 })
      expect(store.pu66.list()).toHaveLength(0)
      expect(
        await applyPu66Upload(store.runtime.http.pu66.importCommands, {
          files,
          expectedFingerprint: pu66Plan.fingerprint,
        }),
      ).toMatchObject({
        added: 4,
      })
      expect(store.pu66.list()).toHaveLength(4)
      expect(store.pu66.list().every((entry) => entry.verification === null)).toBe(true)

      const image = new PNG({ width: 8, height: 8 })
      image.data.fill(255)
      const png = PNG.sync.write(image)
      const archive = Buffer.from(
        zipSync({ 'PNG с номером/1.25.png': png, 'PNG без номера/1.25.png': png }),
      )
      const signFiles = {
        archive: { name: 'synthetic-signs.zip', data: archive.toString('base64') },
        documentCode: 'УЧЕБНЫЙ ИСТОЧНИК',
        edition: 'демо',
        pdf: null,
      }
      const signPlan = previewSignUpload(store.runtime.http.signs.importCommands, signFiles)
      expect(signPlan).toMatchObject({ added: 1, signCount: 1 })
      await applySignUpload(store.runtime.http.signs.importCommands, {
        ...signFiles,
        expectedFingerprint: signPlan.fingerprint,
      })
      expect(store.signCatalog.list()).toHaveLength(1)
      expect(readdirSync(join(directory, 'private-data', 'backups'))).toHaveLength(2)
    } finally {
      store.runtime.close()
    }
    const reopened = openTestApplication(database)
    try {
      expect(reopened.pu66.list()).toHaveLength(4)
      expect(reopened.signCatalog.list()).toHaveLength(1)
    } finally {
      reopened.runtime.close()
    }
  })

  it('accepts a synthetic station crossing with no section and distinguishes its key', async () => {
    const sample = sampleCards[4]!
    const parsed = await parsePu66(await createSampleWorkbook(sample), sample.filename)
    expect(parsed.card.section).toBe('')
    expect(parsed.card.station).toBe(sample.station)
    expect(parsed.card.key).toBe(
      `ст.${sample.station}:${sample.kilometre}:${sample.picket}:к${sample.number}`,
    )
    // Другая карточка той же станции с той же привязкой «км:пк» получает собственный ключ.
    const twin = await parsePu66(
      await createSampleWorkbook({ ...sample, number: 906 }),
      sample.filename,
    )
    expect(twin.card.key).not.toBe(parsed.card.key)
    const ordinary = sampleCards[0]!
    expect(
      (await parsePu66(await createSampleWorkbook(ordinary), ordinary.filename)).card.key,
    ).toBe('90001:12:3')
  })

  it('gives the local editor traffic, visibility and the norm column of a synthetic card', async () => {
    const sample = sampleCards[0]!
    const parsed = await parsePu66(await createSampleWorkbook(sample), sample.filename)
    const store = openTestApplication(':memory:')
    try {
      store.pu66Imports.record([parsed])
      const norms = store.pu66.getNorms(parsed.card.key)!
      expect(norms).toMatchObject({
        referenceId: '90001:12:3',
        carCountPerDay: parsed.card.carCountPerDay,
        roadCategory: parsed.card.roadCategory,
        revision: 1,
      })
      expect(norms.technicalRows.length).toBeGreaterThanOrEqual(30)
      expect(Object.keys(norms.technicalRows[0]!)).toEqual([
        'item',
        'label',
        'statedNorm',
        'previous',
        'current',
      ])
      // Выборка для схемы по-прежнему без технической таблицы и интенсивности.
      expect(store.pu66.getScheme(parsed.card.key)).not.toHaveProperty('technicalRows')
      expect(store.pu66.getNorms('90009:1:1')).toBeNull()
    } finally {
      store.runtime.close()
    }
  })
})
