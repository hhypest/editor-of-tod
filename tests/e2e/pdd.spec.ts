import { readFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'

test('conditional speed is applied explicitly and motorway remains a reference', async ({
  page,
}, testInfo) => {
  await page.goto('/')
  await page
    .getByRole('group', { name: 'Способ открытия проекта' })
    .getByRole('button', { name: 'Открыть файл' })
    .click()
  await page.locator('#scheme-file').setInputFiles({
    name: 'synthetic-pdd.json',
    mimeType: 'application/json',
    buffer: readFileSync('tests/fixtures/legacy-v1-new-fields.json'),
  })
  await page.getByRole('button', { name: /Схема движения.*Размеры и вариант/ }).click()
  await page.getByRole('combobox', { name: 'Местоположение', exact: true }).selectOption('out')
  await page.getByText('Справочник скорости по ПДД', { exact: true }).click()
  const reference = page.locator('.speed-reference')
  await expect(
    reference.getByRole('button', { name: 'Подставить скорость для выбранных условий' }),
  ).toHaveCount(0)
  await reference.getByLabel('Вид дороги для сверки скорости').selectOption('ordinary')
  await reference.getByLabel('Вид ТС для сверки скорости').selectOption('heavy')
  await expect(reference).toContainText('70 км/ч')
  await expect(reference).toContainText('Предварительные числа')
  const approach = page.locator('[data-field="parameters.approachSpeedKmh"]:visible')
  const previous = await approach.inputValue()
  await reference.getByLabel('Вид дороги для сверки скорости').selectOption('motorway')
  await expect(
    reference.getByRole('button', { name: 'Подставить скорость для выбранных условий' }),
  ).toBeDisabled()
  await expect(approach).toHaveValue(previous)
  await reference.getByLabel('Вид дороги для сверки скорости').selectOption('ordinary')
  await reference.getByRole('button', { name: 'Подставить скорость для выбранных условий' }).click()
  await expect(approach).toHaveValue('70')
  await expect(page.locator('[data-field="parameters.speedStagesKmh.2"]:visible')).toHaveValue('40')
  await page.screenshot({ path: testInfo.outputPath('pdd-speed.png'), fullPage: true })
})

test('a missing PDD edition blocks acknowledgments and directs the reviewer to the library', async ({
  page,
}) => {
  await page.route('**/api/normative-parameters', (route) => route.fulfill({ json: [] }))
  await page.goto('/')
  await page
    .getByRole('group', { name: 'Способ открытия проекта' })
    .getByRole('button', { name: 'Открыть файл' })
    .click()
  await page.locator('#scheme-file').setInputFiles({
    name: 'synthetic-pdd.json',
    mimeType: 'application/json',
    buffer: readFileSync('tests/fixtures/legacy-b34-manual.json'),
  })
  await page.getByRole('button', { name: /Проверка и лист.*A4 для сверки/ }).click()
  const check = page.locator('[data-check="pdd-speed"]')
  await expect(check).toContainText('действующая редакция не определена')
  await expect(check.getByRole('checkbox')).toBeDisabled()
  await check.getByRole('link', { name: 'Перейти' }).click()
  await expect(page.locator('#documents-title')).toBeVisible()
})
