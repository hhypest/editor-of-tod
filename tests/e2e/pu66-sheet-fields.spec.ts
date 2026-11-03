import { readFileSync } from 'node:fs'
import { expect, test } from './workspace-test'
import { PNG } from 'pngjs'
import { drawableWithoutImage } from '../../src/domain/sign-code'
import { usedSignCodes } from '../../src/domain/sign-images'
import { importSchemeJson } from '../../src/domain/import'

test('sheet retains the train summary, omits technical visibility and preserves the full JSON snapshot', async ({
  page,
  browserName,
}, testInfo) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  const original = JSON.parse(
    readFileSync('tests/fixtures/frozen/projects/project-v11-native-b34.json', 'utf8'),
  )
  // A six-note signs case, like the reported layout; technical rows remain in the snapshot.
  original.parameters.regulation.mode = 'signs'
  original.parameters.regulation.hourly = '101'
  // The historical fixture includes extra manual posts overlapping its template rows.
  // This printable six-note sample retains the PU-66 snapshot and omits those extra posts.
  original.placements = original.placements.filter((post: { id: number }) => post.id < 22)
  const codes = usedSignCodes(importSchemeJson(JSON.stringify(original)).scheme)
  const images = codes.filter((code) => !drawableWithoutImage(code))
  const icon = new PNG({ width: 60, height: 60 })
  for (let i = 0; i < icon.data.length; i += 4) icon.data.set([30, 110, 180, 255], i)
  await page.route('**/api/signs', (route) =>
    route.fulfill({ json: images.map((code) => ({ code, width: 60, height: 60, revision: 1 })) }),
  )
  await page.route('**/api/signs/catalog', (route) =>
    route.fulfill({ json: { id: 1, documentCode: 'УЧЕБНЫЙ', edition: '2026' } }),
  )
  await page.route(/\/api\/signs\/[^/]+\/metadata(?:\?|$)/, (route) =>
    route.fulfill({
      json: {
        code: decodeURIComponent(new URL(route.request().url()).pathname.split('/')[3]!),
        width: 60,
        height: 60,
        revision: 1,
      },
    }),
  )
  await page.route(/\/api\/signs\/[^/]+\/image(?:\?|$)/, (route) =>
    route.fulfill({ contentType: 'image/png', body: PNG.sync.write(icon) }),
  )
  const fixture = Buffer.from(JSON.stringify(original))
  await page.goto('/')
  await page.getByRole('button', { name: 'Открыть файл' }).click()
  await page.locator('#scheme-file').setInputFiles({
    name: 'fictional-pu66-v11.json',
    mimeType: 'application/json',
    buffer: fixture,
  })
  await page.getByRole('button', { name: /Проверка и лист.*A4 для сверки/ }).click()
  const sheet = page.locator('.print-host .sheet-paper')
  await expect(sheet).toContainText('Учебная станция Гамма')
  await expect(sheet).toContainText('Учебный перегон Альфа — Бета')
  await expect(sheet).toContainText('нечётного направления 111')
  await expect(sheet).toContainText('чётного 222')
  await expect(sheet).not.toContainText('2029 / 2030')
  await expect(sheet).not.toContainText('Видимость встречного автомобиля с востока')
  await expect(sheet).not.toContainText('101 / 202')
  const notes = sheet.locator('text').filter({ hasText: /^[1-9]\d*\. / })
  await expect(notes).toHaveCount(6)
  await expect(notes.nth(0)).toContainText('1. Работы:')
  await expect(notes.nth(1)).toContainText('2. Очерёдность проезда')
  await expect(notes.nth(2)).toContainText('3. Расстояния установки знаков')
  await expect(notes.nth(3)).toContainText('4. Типоразмер знаков')
  await expect(notes.nth(4)).toContainText('5. Принятая интенсивность')
  await expect(notes.nth(5)).toContainText('6. Видимость поезда')
  await expect(page.locator('.print-host:not(.thumbnail) .print-blocked-note')).toHaveText([])
  const markup = await sheet.evaluate((element) => element.outerHTML)
  const applicationUrl = page.url()
  const pngDownload = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Скачать PNG', exact: true }).click()
  const bytes = readFileSync((await (await pngDownload).path())!),
    png = PNG.sync.read(bytes)
  expect([png.width, png.height]).toEqual([3528, 2495])
  await testInfo.attach('fictional-six-notes-PNG', { body: bytes, contentType: 'image/png' })
  await page.emulateMedia({ media: 'print' })
  if (browserName === 'chromium') {
    const pdf = await page.pdf({ printBackground: true, preferCSSPageSize: true })
    expect(pdf.toString('latin1').match(/\/Type\s*\/Page\b/g) ?? []).toHaveLength(1)
  }
  await page.emulateMedia({ media: 'screen' })
  await page.getByText('Действия с проектом', { exact: true }).click()
  const jsonDownload = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Скачать файл проекта', exact: true }).click()
  const saved = JSON.parse(readFileSync((await (await jsonDownload).path())!, 'utf8'))
  expect(saved.crossing.snapshot).toEqual(original.crossing.snapshot)
  // Capture the actual SVG in an isolated document. A Firefox download may finish a
  // navigation on the application page; replacing that live document races its lifecycle.
  const render = await page.context().newPage()
  try {
    await render.setViewportSize({ width: 1760, height: 1250 })
    await render.route(/\/api\/signs\/[^/]+\/image(?:\?|$)/, (route) =>
      route.fulfill({ contentType: 'image/png', body: PNG.sync.write(icon) }),
    )
    await render.setContent(
      `<base href="${applicationUrl}"><style>body{margin:0}svg{background:white}text{white-space:pre}</style>${markup}`,
    )
    const standalone = render.locator('svg.sheet-paper')
    await expect(standalone).toHaveCount(1)
    await standalone.evaluate((element) => {
      element.style.width = '1680px'
      element.style.height = '1188px'
    })
    const filename = testInfo.outputPath('fictional-pu66-sheet.png')
    await standalone.screenshot({ path: filename })
    await render.screenshot({
      path: testInfo.outputPath('fictional-pu66-notes.png'),
      clip: { x: 880, y: 770, width: 800, height: 250 },
    })
    await testInfo.attach('fictional-pu66-sheet', { path: filename, contentType: 'image/png' })
  } finally {
    await render.close()
  }
  expect(errors).toEqual([])
})
