import { readFileSync } from 'node:fs'
import { PNG } from 'pngjs'
import { expect, test } from './workspace-test'
import { createUnlinkedScheme } from '../../src/domain/create-scheme'
import { exportSchemeJson } from '../../src/domain/import'

/** Own synthetic image: an arrow and a coloured placeholder, no extracted standard assets. */
function baseImage(right: boolean) {
  const png = new PNG({ width: 200, height: 100 })
  png.data.fill(255)
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      const ax = right ? x / png.width : 1 - x / png.width
      const ay = y / png.height
      const shaft = ax >= 0.065 && ax <= 0.19 && ay >= 0.43 && ay <= 0.57
      const head = ax >= 0.19 && ax <= 0.35 && Math.abs(ay - 0.5) <= (0.35 - ax) * 1.1875
      const placeholder = ax > 0.4 && ax < 0.93 && ay > 0.1 && ay < 0.2
      const offset = (y * png.width + x) * 4
      if (shaft || head) png.data.fill(0, offset, offset + 3)
      else if (placeholder) png.data.set([255, 0, 255], offset)
    }
  }
  return PNG.sync.write(png)
}

for (const withBase of [false, true]) {
  test(`directional distances retain arrows and numbers in preview, print and PNG (${withBase ? 'catalog base' : 'fallback'})`, async ({
    page,
    browserName,
  }, testInfo) => {
    const bases = ['8.1.3', '8.1.4']
    const images = bases.map((_, index) => baseImage(index === 0))
    await page.route('**/api/signs', (route) =>
      route.fulfill({
        json: withBase ? bases.map((code) => ({ code, width: 200, height: 100, revision: 2 })) : [],
      }),
    )
    await page.route('**/api/signs/catalog', (route) =>
      route.fulfill({
        json: { id: 1, documentCode: 'УЧЕБНЫЙ', edition: '2026' },
      }),
    )
    for (const [index, base] of bases.entries()) {
      await page.route(`**/api/signs/${base}/image?*`, (route) =>
        route.fulfill({
          contentType: 'image/png',
          body: images[index],
        }),
      )
      await page.route(`**/api/signs/${base}/metadata?*`, (route) =>
        route.fulfill({
          json: { code: base, width: 200, height: 100, revision: 2 },
        }),
      )
    }
    const scheme = createUnlinkedScheme({
      referenceId: 'TEST-DIRECTION',
      locationText: 'Учебная дорога',
      directionLeft: 'А',
      directionRight: 'Б',
      frontMetres: '18',
      taperMetres: '10',
      bufferMetres: '10',
      location: 'out',
      approachSpeedKmh: '90',
      speedStagesKmh: ['70', '50', '40'],
      yellowTemporarySigns: false,
    })
    const codes = ['8.1.3_120', '8.1.4_120', '8.1.3_1234567', '8.1.4_1234567']
    scheme.placements = codes.map((code, index) => ({
      kind: 'sign-post',
      id: index + 1,
      generatedByTemplate: false,
      position: { anchor: 'abs', offsetXSvg: 200 + index * 180, offsetYSvg: 0 },
      side: 'up',
      stand: 'right',
      signIds: [code],
      distance: null,
      distanceLabel: null,
    }))
    scheme.nextPlacementId = 5
    if (withBase)
      scheme.signImages = {
        catalog: { id: 1, documentCode: 'УЧЕБНЫЙ', edition: '2026' },
        revisions: { '8.1.3': 2, '8.1.4': 2 },
      }
    await page.goto('/')
    await page.getByRole('button', { name: 'Открыть файл', exact: true }).click()
    await page.locator('#scheme-file').setInputFiles({
      name: 'directional-distances.json',
      mimeType: 'application/json',
      buffer: Buffer.from(exportSchemeJson(scheme)),
    })
    await page.getByRole('button', { name: /Знаки и объекты.*Поле и свойства/ }).click()
    for (const code of codes) {
      const preview = page.locator(`[data-drawn-preview="${code}"]`).first()
      await expect(preview).toContainText(`${code.split('_')[1]} м`)
      await expect(preview.locator(withBase ? 'image' : 'polygon')).toHaveCount(1)
    }
    await page.getByRole('button', { name: /Проверка и лист.*A4 для сверки/ }).click()
    const host = page.locator('.print-host:not(.thumbnail)')
    await expect(host.locator('[data-missing-sign]')).toHaveCount(0)
    for (const code of codes) {
      const plate = host.locator(`[data-drawn-sign="${code}"]`)
      await expect(plate).toContainText(`${code.split('_')[1]} м`)
      if (withBase)
        await expect(plate.locator('image')).toHaveAttribute('data-sign-base', code.split('_')[0]!)
      else
        await expect(plate.locator('polygon')).toHaveAttribute(
          'data-sign-arrow',
          code.startsWith('8.1.3') ? 'right' : 'left',
        )
      // Text fits inside its own masked region even for a seven-digit manual value.
      expect(
        await plate.evaluate((element) => {
          const text = element.querySelector('text')!.getBBox()
          const shape = element.querySelector<SVGGraphicsElement>('image, rect')!
          const area = shape.getBBox()
          if (shape.tagName === 'rect') {
            area.x -= 1
            area.y -= 1
            area.width += 2
            area.height += 2
          }
          const right = element.getAttribute('data-drawn-sign')!.startsWith('8.1.3')
          const left = area.x + area.width * (right ? 0.385 : 0.055)
          const edge = area.x + area.width * (right ? 0.945 : 0.615)
          return { fits: text.x >= left - 1 && text.x + text.width <= edge + 1 }
        }),
      ).toMatchObject({ fits: true })
    }
    await page.emulateMedia({ media: 'print' })
    for (const code of codes)
      await expect(host.locator(`[data-drawn-sign="${code}"]`)).toBeVisible()
    if (browserName === 'chromium') {
      const pdf = await page.pdf({ printBackground: true, preferCSSPageSize: true })
      expect(pdf.toString('latin1').match(/\/Type\s*\/Page\b/g) ?? []).toHaveLength(1)
    }
    await page.emulateMedia({ media: 'screen' })
    // Sheet coordinates are also PNG coordinates before the standard export scale of 2.1.
    const boxes = await host.locator('[data-drawn-sign]').evaluateAll((elements) =>
      elements.map((element) => {
        const shape = element.querySelector<SVGGraphicsElement>('image, rect')!
        const area = shape.getBBox()
        if (shape.tagName === 'rect') {
          area.x -= 1
          area.y -= 1
          area.width += 2
          area.height += 2
        }
        const right = element.getAttribute('data-drawn-sign')!.startsWith('8.1.3')
        return { x: area.x, y: area.y, w: area.width, h: area.height, right }
      }),
    )
    const download = page.waitForEvent('download')
    await host.getByRole('button', { name: 'Скачать PNG' }).click()
    const bytes = readFileSync((await (await download).path())!)
    await testInfo.attach('directional-distances-sheet', { body: bytes, contentType: 'image/png' })
    const png = PNG.sync.read(bytes)
    expect([png.width, png.height]).toEqual([3528, 2495])
    for (const box of boxes) {
      const pixel = (fx: number, fy: number) => {
        const x = Math.round((box.x + box.w * fx) * 2.1)
        const y = Math.round((box.y + box.h * fy) * 2.1)
        return [...png.data.subarray((y * png.width + x) * 4, (y * png.width + x) * 4 + 3)]
      }
      // Arrow tip and shaft survive; the area above the tip and the old placeholder are blank.
      for (const fx of [0.12, 0.3])
        expect(Math.max(...pixel(box.right ? fx : 1 - fx, 0.5))).toBeLessThan(80)
      expect(Math.min(...pixel(box.right ? 0.3 : 0.7, 0.22))).toBeGreaterThan(230)
      expect(Math.min(...pixel(0.5, 0.15))).toBeGreaterThan(230)
      // The number is rasterized too, separately from the arrow and border.
      let ink = 0
      const fromX = Math.ceil((box.x + box.w * (box.right ? 0.4 : 0.07)) * 2.1)
      const toX = Math.floor((box.x + box.w * (box.right ? 0.93 : 0.6)) * 2.1)
      const fromY = Math.ceil((box.y + box.h * 0.3) * 2.1)
      const toY = Math.floor((box.y + box.h * 0.72) * 2.1)
      for (let y = fromY; y <= toY; y++)
        for (let x = fromX; x <= toX; x++) {
          const offset = (y * png.width + x) * 4
          if (Math.max(...png.data.subarray(offset, offset + 3)) < 100) ink++
        }
      expect(ink).toBeGreaterThan(20)
    }
  })
}
