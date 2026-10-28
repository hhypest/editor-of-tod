import { readFileSync } from 'node:fs'
import { expect, test } from './workspace-test'

test('pinned PU-66 visibility and railway fields survive JSON and render on the sheet', async ({
  page,
}, testInfo) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  const fixture = readFileSync('tests/fixtures/frozen/projects/project-v11-native-b34.json')
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
  await expect(sheet).toContainText('2029 / 2030')
  await expect(sheet).toContainText('Видимость встречного автомобиля с востока')
  await expect(sheet).toContainText('101 / 202')
  // Capture the actual SVG at its viewBox size, outside the scrollable editor viewport.
  const markup = await sheet.evaluate((element) => element.outerHTML)
  await page.setViewportSize({ width: 1760, height: 1250 })
  await page.setContent(
    `<style>body{margin:0}svg{background:white}text{white-space:pre}</style>${markup}`,
  )
  const standalone = page.locator('svg')
  await standalone.evaluate((element) => {
    element.style.width = '1680px'
    element.style.height = '1188px'
  })
  const filename = testInfo.outputPath('fictional-pu66-sheet.png')
  await standalone.screenshot({ path: filename })
  await testInfo.attach('fictional-pu66-sheet', { path: filename, contentType: 'image/png' })
  expect(errors).toEqual([])
})
