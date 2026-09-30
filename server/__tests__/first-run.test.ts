import { mkdtempSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { zipSync } from 'fflate'
import { PNG } from 'pngjs'
import { createSampleWorkbook, sampleCards } from '../../scripts/generate-pu66-samples.ts'
import { parsePu66 } from '../pu66.ts'
import { RegistryStore } from '../store.ts'
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

    const store = new RegistryStore(database)
    try {
      expect(existsSync(database)).toBe(true)
      expect(store.listPu66()).toHaveLength(0)
      expect(store.listSigns()).toHaveLength(0)
      expect(store.listNormative()).toHaveLength(4)

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
      const pu66Plan = await previewPu66Upload(store, { files })
      expect(pu66Plan).toMatchObject({ added: 4, updated: 0, unchanged: 0 })
      expect(store.listPu66()).toHaveLength(0)
      expect(
        await applyPu66Upload(store, { files, expectedFingerprint: pu66Plan.fingerprint }),
      ).toMatchObject({
        added: 4,
      })
      expect(store.listPu66()).toHaveLength(4)
      expect(store.listPu66().every((entry) => entry.verification === null)).toBe(true)

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
      const signPlan = previewSignUpload(store, signFiles)
      expect(signPlan).toMatchObject({ added: 1, signCount: 1 })
      await applySignUpload(store, { ...signFiles, expectedFingerprint: signPlan.fingerprint })
      expect(store.listSigns()).toHaveLength(1)
      expect(readdirSync(join(directory, 'private-data', 'backups'))).toHaveLength(2)
    } finally {
      store.close()
    }
    const reopened = new RegistryStore(database)
    try {
      expect(reopened.listPu66()).toHaveLength(4)
      expect(reopened.listSigns()).toHaveLength(1)
    } finally {
      reopened.close()
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
    const store = new RegistryStore(':memory:')
    try {
      store.importPu66([parsed])
      const norms = store.getPu66Norms(parsed.card.key)!
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
      expect(store.getPu66Scheme(parsed.card.key)).not.toHaveProperty('technicalRows')
      expect(store.getPu66Norms('90009:1:1')).toBeNull()
    } finally {
      store.close()
    }
  })
})
