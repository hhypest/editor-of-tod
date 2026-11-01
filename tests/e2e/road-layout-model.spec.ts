import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { expect, test } from './workspace-test'
import { schemeSchema } from '../../src/domain/model'

test('native v12 roads are visible, persist through save/export, and cannot bypass the geometry guard', async ({
  page,
}, testInfo) => {
  const scheme = schemeSchema.parse(
    JSON.parse(readFileSync('tests/fixtures/frozen/projects/project-v12-native-b34.json', 'utf8')),
  )
  scheme.id = randomUUID()
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto('/')
  await page.getByRole('button', { name: 'Открыть файл', exact: true }).click()
  await page.locator('#scheme-file').setInputFiles({
    name: 'fictional-native-roads-v12.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(scheme)),
  })
  await page.getByRole('button', { name: /Знаки и объекты/ }).click()
  const summary = page.locator('[data-test="road-layout-summary"]')
  await expect(summary.getByRole('row')).toHaveCount(4)
  await expect(summary.getByRole('row', { name: /Учебное примыкание Альфа/ })).toContainText(
    '120 м от L0',
  )
  await expect(summary.getByRole('row', { name: /Учебный выезд Бета/ })).toContainText('100 м от E')
  await expect(summary.getByRole('row', { name: /Конечный Т-перекрёсток/ })).toContainText(
    '300 м от E',
  )
  await expect(summary).toContainText('Учебная ветвь Север / Учебная ветвь Юг')
  await summary.screenshot({ path: testInfo.outputPath('road-layout-summary.png') })
  await page.getByRole('button', { name: 'Собрать черновой шаблон', exact: true }).click()
  await expect(
    page.getByRole('alert').filter({ hasText: 'Данные примыканий сохранены' }),
  ).toBeVisible()
  await page.getByRole('button', { name: /Проверка и лист.*A4 для сверки/ }).click()
  await expect(
    page.getByRole('listitem').filter({ hasText: 'Геометрия примыканий' }),
  ).toContainText('автоматика ещё не реализованы')
  await expect(
    page.locator('.print-host:not(.thumbnail)').getByLabel(/Я проверил лист/),
  ).toBeDisabled()
  await page.getByRole('button', { name: 'Сохранить проект', exact: true }).click()
  await expect(page.locator('.save-state')).toHaveText('Сохранён')
  await page.getByText('Действия с проектом', { exact: true }).click()
  const pending = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Скачать файл проекта', exact: true }).click()
  const reopened = schemeSchema.parse(
    JSON.parse(readFileSync((await (await pending).path())!, 'utf8')),
  )
  expect(reopened).toEqual(scheme)
  expect(reopened.roadLayout).toEqual(scheme.roadLayout)
  expect(errors).toEqual([])
})
