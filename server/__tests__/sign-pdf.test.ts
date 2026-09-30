import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PNG } from 'pngjs'
import { afterEach, describe, expect, it } from 'vitest'
import { applyDocumentUpload, previewDocumentUpload } from '../document-web-import'
import {
  assignSignCodes,
  extractPdfSigns,
  findYellowRule,
  yellowCodes,
  yellowVariant,
  type PdfSignExtraction,
} from '../sign-pdf'
import { applyPdfSigns, pdfSignImage, previewPdfSigns } from '../sign-pdf-import'
import { RegistryStore } from '../store'
import { buildPdf, fictionalSignStandard as standard } from './pdf-fixture'

function pixel(png: Buffer, x: number, y: number): number[] {
  const image = PNG.sync.read(png)
  const offset = (y * image.width + x) * 4
  return Array.from(image.data.subarray(offset, offset + 4))
}

const directories: string[] = []
const stores: RegistryStore[] = []
afterEach(() => {
  // На Windows открытый файл SQLite не даёт удалить временную папку.
  for (const store of stores.splice(0)) store.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('sign images from the PDF of a standard', () => {
  let extraction: PdfSignExtraction
  it('finds images of appendix A tables and the number printed under each', async () => {
    extraction = await extractPdfSigns(standard())
    expect(extraction.pages).toEqual({ first: 2, last: 3 })
    expect(
      extraction.images.map(({ key, page, code, example }) => ({ key, page, code, example })),
    ).toEqual([
      { key: '2-1', page: 2, code: '1.8', example: false },
      { key: '2-2', page: 2, code: '1.15', example: false },
      { key: '2-3.1', page: 2, code: '1.34.1', example: false },
      { key: '2-3.2', page: 2, code: '1.34.1', example: false },
      { key: '2-4', page: 2, code: '1.16', example: false },
      { key: '2-5', page: 2, code: null, example: false },
      { key: '3-1', page: 3, code: '6.9.1', example: true },
    ])
    expect(extraction.yellow).toEqual({
      clause: '3.2',
      text: 'Знаки 1.8, 1.15 - 1.16 допускается выполнять с желтым фоном.',
      items: ['1.8', '1.15-1.16'],
    })
  })

  it('makes the field around a sign transparent and keeps the sign opaque', () => {
    const triangle = extraction.images[0]!
    expect(pixel(triangle.png, 0, 0)[3]).toBe(0)
    // Белый фон внутри каймы остаётся непрозрачным.
    expect(pixel(triangle.png, 30, 40)).toEqual([255, 255, 255, 255])
    const parts = extraction.images.filter((image) => image.code === '1.34.1')
    expect(parts.every((part) => part.width < 60)).toBe(true)
  })

  it('assigns variants, applies corrections and builds yellow variants from the clause', () => {
    const { assignments, entries, yellow } = assignSignCodes(
      extraction,
      { '2-5': '1.33', '3-1': null },
      'a'.repeat(64),
    )
    expect(assignments.map((item) => [item.key, item.code, item.reason])).toEqual([
      ['2-1', '1.8', 'detected'],
      ['2-2', '1.15', 'detected'],
      ['2-3.1', '1.34.1', 'detected'],
      ['2-3.2', '1.34.1_v2', 'detected'],
      ['2-4', '1.16', 'detected'],
      ['2-5', '1.33', 'override'],
      ['3-1', null, 'excluded'],
    ])
    expect(yellow).toEqual(['1.8', '1.15', '1.16'])
    expect(entries.map((entry) => entry.code)).toEqual([
      '1.8',
      '1.8_ж',
      '1.15',
      '1.15_ж',
      '1.16',
      '1.16_ж',
      '1.33',
      '1.34.1',
      '1.34.1_v2',
    ])
    expect(entries.every((entry) => entry.zipSha256 === 'a'.repeat(64))).toBe(true)
    const plain = entries.find((entry) => entry.code === '1.8')!.plainPng
    const painted = entries.find((entry) => entry.code === '1.8_ж')!.plainPng
    expect(pixel(painted, 30, 40)).toEqual([254, 220, 0, 255])
    // Кайма и поле вокруг знака не меняются.
    expect(pixel(painted, 30, 50)).toEqual(pixel(plain, 30, 50))
    expect(pixel(painted, 0, 0)[3]).toBe(0)
  })

  it('reads ranges of the yellow list by sign number order', () => {
    const rule = findYellowRule(
      '3.2 Номера знаков, их наименования и изображения приведены в таблицах А.1 - А.8 приложения А. Знаки 1.18 - 1.21, 3.18.1 - 3.25, 6.22 допускается выполнять с желтым фоном.',
    )
    expect(rule?.items).toEqual(['1.18-1.21', '3.18.1-3.25', '6.22'])
    const codes = [
      '1.17',
      '1.18',
      '1.20.3',
      '1.21',
      '1.22',
      '3.17.3',
      '3.18.1',
      '3.24',
      '3.25',
      '3.26',
      '6.22',
    ]
    expect([...yellowCodes(rule, codes)]).toEqual([
      '1.18',
      '1.20.3',
      '1.21',
      '3.18.1',
      '3.24',
      '3.25',
      '6.22',
    ])
    expect(findYellowRule('Текст без перечня')).toBeNull()
  })

  it('turns enclosed background (inside of digits, windows) yellow but keeps the outer rim white', () => {
    // Круглый знак: прозрачное поле, белая кайма, красное кольцо, белый фон и чёрная «цифра 0»
    // с белой внутренностью.
    const size = 64
    const image = new PNG({ width: size, height: size })
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const r = Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2)
        const offset = (y * size + x) * 4
        const colour =
          r > 30
            ? [0, 0, 0, 0]
            : r > 28
              ? [255, 255, 255, 255]
              : r > 21
                ? [220, 30, 40, 255]
                : r > 10 || r < 6
                  ? [255, 255, 255, 255]
                  : [0, 0, 0, 255]
        image.data.set(colour, offset)
      }
    }
    const result = PNG.sync.read(yellowVariant(PNG.sync.write(image)))
    const pixel = (x: number, y: number) =>
      Array.from(result.data.subarray((y * size + x) * 4, (y * size + x) * 4 + 3))
    expect(pixel(32, 32)).toEqual([254, 220, 0]) // внутренность «0»
    expect(pixel(32, 17)).toEqual([254, 220, 0]) // фон знака
    expect(pixel(32, 3)).toEqual([255, 255, 255]) // наружная кайма
    expect(pixel(32, 8)).toEqual([220, 30, 40]) // кольцо не меняется
  })

  it('leaves a sign without inner white background unchanged', () => {
    const plate = extraction.images[1]!.png
    expect(yellowVariant(plate).equals(plate)).toBe(true)
  })

  it('reports a PDF without sign tables', async () => {
    const empty = await extractPdfSigns(buildPdf([[{ t: 'text', x: 57, y: 700, text: 'Текст' }]]))
    expect(empty).toEqual({ pages: null, images: [], yellow: null })
  })
})

describe('sign catalog from a library document', () => {
  async function library(kind: 'signs' | 'rules' = 'signs') {
    const directory = mkdtempSync(join(tmpdir(), 'tod-sign-pdf-'))
    directories.push(directory)
    const store = new RegistryStore(join(directory, 'registry.sqlite'))
    stores.push(store)
    const body = {
      file: { name: 'uchebny-standart.pdf', data: standard().toString('base64') },
      meta: {
        code: 'ГОСТ Р 90000',
        edition: '2025',
        title: 'Учебный стандарт знаков',
        kind,
        effectiveFrom: '2026-01-01',
        amendsId: null,
        note: '',
        actualCheckedAt: '',
      },
    }
    const now = new Date('2026-09-29T12:00:00')
    const preview = previewDocumentUpload(store, body, now)
    const { document } = await applyDocumentUpload(
      store,
      { ...body, expectedFingerprint: preview.fingerprint },
      now,
    )
    return { store, document }
  }

  it('refuses to write while an image has no number and is not excluded', async () => {
    const { store, document } = await library()
    const preview = await previewPdfSigns(store, document.id, {})
    expect(preview.images.find((image) => image.key === '2-5')?.reason).toBe('no-label')
    await expect(
      applyPdfSigns(store, document.id, {
        overrides: {},
        expectedFingerprint: preview.fingerprint,
      }),
    ).rejects.toThrow('2-5 не указан номер')
    expect(store.latestSignCatalog()).toBeNull()
    const excluded = { '2-5': null }
    const plan = await previewPdfSigns(store, document.id, { overrides: excluded })
    const result = await applyPdfSigns(store, document.id, {
      overrides: excluded,
      expectedFingerprint: plan.fingerprint,
    })
    expect(result.signCount).toBe(9)
  })

  it('previews and writes the catalog with the document as its source', async () => {
    const { store, document } = await library()
    const overrides = { '2-5': '1.33' }
    const preview = await previewPdfSigns(store, document.id, { overrides })
    expect(preview.signCount).toBe(10)
    expect(preview.addedCodes).toContain('1.34.1_v2')
    expect(preview.yellowCodes).toEqual(['1.8', '1.15', '1.16'])
    expect(preview.images.find((image) => image.key === '2-5')).toMatchObject({
      detected: null,
      code: '1.33',
      reason: 'override',
    })
    expect(preview.source).toEqual({
      documentCode: 'ГОСТ Р 90000',
      edition: '2025',
      pdfSha256: document.sha256,
      documentId: document.id,
    })
    await expect(
      applyPdfSigns(store, document.id, {
        overrides: {},
        expectedFingerprint: preview.fingerprint,
      }),
    ).rejects.toThrow()
    const result = await applyPdfSigns(store, document.id, {
      overrides,
      expectedFingerprint: preview.fingerprint,
    })
    expect(result.backup).toMatch(/\.sqlite$/)
    expect(result.catalog).toMatchObject({ documentId: document.id, signCount: 10 })
    expect(store.listSigns().map((sign) => sign.code)).toContain('1.16_ж')
    const again = await previewPdfSigns(store, document.id, { overrides })
    expect(again).toMatchObject({ added: 0, updated: 0, retired: 0, unchanged: 10 })
    const png = await pdfSignImage(store, document.id, '2-1', true)
    expect(pixel(png, 30, 40)).toEqual([254, 220, 0, 255])
  })

  it('accepts only sign documents and known images', async () => {
    const { store, document } = await library('rules')
    await expect(previewPdfSigns(store, document.id, {})).rejects.toThrow('Изображения знаков')
    const signs = await library()
    await expect(
      previewPdfSigns(signs.store, signs.document.id, { overrides: { '9-9': '1.1' } }),
    ).rejects.toThrow('Нет изображений 9-9')
    await expect(
      previewPdfSigns(signs.store, signs.document.id, { overrides: { '2-5': '1.8_ж' } }),
    ).rejects.toThrow()
  })
})
