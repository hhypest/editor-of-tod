import { expect, test } from '@playwright/test'
import { createSampleWorkbook, sampleCards } from '../../scripts/generate-pu66-samples'

test('regulation uses the strict 250 boundary and limited visibility without rewriting the selected mode', async ({
  page,
  request,
}) => {
  const workbook = await createSampleWorkbook({
    ...sampleCards[0]!,
    section: 'Учебный профиль (99888)',
    kilometre: 888,
    length: 40,
  })
  const files = [{ name: 'rail-profile.xlsx', data: workbook.toString('base64') }]
  const headers = { Origin: 'http://127.0.0.1:5173' }
  const preview = await request.post('http://127.0.0.1:4100/api/pu66/import/preview', {
    headers,
    data: { files },
  })
  expect(preview.ok()).toBeTruthy()
  const plan = await preview.json()
  const apply = await request.post('http://127.0.0.1:4100/api/pu66/import/apply', {
    headers,
    data: { files, expectedFingerprint: plan.fingerprint },
  })
  expect(apply.ok()).toBeTruthy()
  await page.goto('/')
  await page.getByRole('button', { name: 'Новый проект', exact: true }).click()
  await page.getByLabel('Поиск карточки').fill('888')
  await page.getByLabel('Локальная карточка').selectOption('99888:888:3')
  await page.getByLabel('Участок', { exact: true }).fill('Учебная дорога')
  await page.getByLabel('Направление слева').fill('А')
  await page.getByLabel('Направление справа').fill('Б')
  await page.getByLabel('Фронт работ, м', { exact: true }).fill('21,5')
  await page.getByLabel('Отвод, м', { exact: true }).fill('10')
  await page.getByLabel('Буфер, м', { exact: true }).fill('10')
  await page.getByLabel('Вне населённого пункта', { exact: true }).check()
  await page.locator('[data-field="parameters.workConditions.kind"]:visible').selectOption('short')
  await page.locator('[data-field="parameters.workConditions.durationHours"]:visible').fill('4')
  await page
    .locator('[data-field="parameters.workConditions.daylight"]:visible')
    .selectOption('day')
  await page.locator('[data-field="parameters.workConditions.regulatorsPresent"]:visible').check()
  await page.getByRole('button', { name: 'Создать проект' }).click()
  await page.getByRole('button', { name: /Схема движения.*Размеры и вариант/ }).click()
  await page.getByLabel('Прямой участок; регулировщик виден с обоих концов рабочей зоны').check()
  const flow = page.getByLabel('Интенсивность, авт./ч (по данным составителя)')
  const heading = page.locator('.advice').getByRole('heading')
  for (const [hourly, label] of [
    [249, 'знаки приоритета'],
    [250, 'один регулировщик'],
    [251, 'один регулировщик'],
    [500, 'один регулировщик'],
    [501, 'два регулировщика'],
    [915, 'два регулировщика'],
  ] as const) {
    await flow.fill(String(hourly))
    await expect(heading).toContainText(label)
    await expect(page.getByLabel('Регулирование Б.34')).toHaveValue('auto')
  }
  await page.getByLabel('Видимость встречного автомобиля ограничена').check()
  for (const hourly of [180, 250, 298, 915]) {
    await flow.fill(String(hourly))
    await expect(heading).toContainText('два регулировщика')
  }
})
