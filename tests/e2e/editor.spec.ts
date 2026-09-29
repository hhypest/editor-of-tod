import { readFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'
import { zipSync } from 'fflate'
import { PNG } from 'pngjs'
import { createSampleWorkbook, sampleCards } from '../../scripts/generate-pu66-samples'

const api = 'http://127.0.0.1:4100'
const origin = 'http://127.0.0.1:5173'

test('new project: form edits apply, review opens, and console stays clean', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto('/')
  await page.getByLabel('Локальный идентификатор переезда').fill('TEST-BROWSER')
  await page.getByLabel('Фронт работ, м').fill('18')
  await page.getByLabel('Отвод, м').fill('10')
  await page.getByLabel('Буфер, м').fill('10')
  await page.getByLabel('Первая').fill('70')
  await page.getByLabel('Вторая').fill('50')
  await page.getByLabel('Третья').fill('40')
  await page.getByRole('button', { name: 'Создать проект' }).click()
  await page.getByRole('button', { name: /Схема движения.*Размеры и вариант/ }).click()
  await expect(page.getByRole('heading', { name: 'Размеры и параметры схемы' })).toBeVisible()
  await page.getByLabel('n100').fill('100')
  await page.getByRole('button', { name: 'Применить правки' }).click()
  await page.getByRole('button', { name: /Проверка и лист.*A4 для сверки/ }).click()
  await expect(page.getByRole('heading', { name: 'Реквизиты листа и согласования' })).toBeVisible()
  await expect(page.locator('.print-host')).toContainText('18 м')
  expect(errors).toEqual([])
})

test('review findings move focus to the first empty field', async ({ page }) => {
  await page.goto('/')
  await page.getByLabel('Локальный идентификатор переезда').fill('TEST-FOCUS')
  await page.getByLabel('Фронт работ, м').fill('18')
  await page.getByLabel('Отвод, м').fill('10')
  await page.getByLabel('Буфер, м').fill('10')
  await page.getByLabel('Первая').fill('70')
  await page.getByLabel('Вторая').fill('50')
  await page.getByLabel('Третья').fill('40')
  await page.getByRole('button', { name: 'Создать проект' }).click()
  await page.getByRole('button', { name: /Проверка и лист.*A4 для сверки/ }).click()
  const findings = page.locator('li', { hasText: 'Место работ и направления' })
  await findings.getByRole('link', { name: 'Перейти' }).click()
  await expect(page.locator('[data-field="parameters.locationText"]')).toBeFocused()
  await page.getByRole('button', { name: /Проверка и лист.*A4 для сверки/ }).click()
  await page
    .locator('li', { hasText: 'Утверждение владельцем дороги' })
    .getByRole('link', { name: 'Перейти' })
    .click()
  await expect(page.locator('[data-field="titleBlock.approver.position"]')).toBeFocused()

  // Незавершённая правка объекта блокирует форму: переход объясняет причину и ведёт к правке.
  await page.getByRole('button', { name: /Знаки и объекты.*Поле и свойства/ }).click()
  await page.getByRole('button', { name: 'Добавить надпись' }).click()
  await page.getByRole('button', { name: /Проверка и лист.*A4 для сверки/ }).click()
  await page
    .locator('li', { hasText: 'Место работ и направления' })
    .getByRole('link', { name: 'Перейти' })
    .click()
  await expect(page.getByRole('status').filter({ hasText: 'правка объекта' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Знаки и объекты', level: 1 })).toBeVisible()
})

test('restores applied edits and unapplied fields after the window closes', async ({
  page,
  request,
}) => {
  await page.goto('/')
  await page.getByLabel('Локальный идентификатор переезда').fill('TEST-RECOVERY')
  await page.getByLabel('Фронт работ, м').fill('18')
  await page.getByLabel('Отвод, м').fill('10')
  await page.getByLabel('Буфер, м').fill('10')
  await page.getByLabel('Первая').fill('70')
  await page.getByLabel('Вторая').fill('50')
  await page.getByLabel('Третья').fill('40')
  await page.getByRole('button', { name: 'Создать проект' }).click()
  await page.getByRole('button', { name: /Схема движения.*Размеры и вариант/ }).click()
  await page.getByLabel('n100').fill('100')
  await page.getByRole('button', { name: 'Применить правки' }).click()
  await page.getByLabel('n50').fill('50')
  await expect(page.locator('.save-state')).toContainText('копия восстановления записана')

  const recovery = await (await request.get(`${api}/api/recovery`)).json()
  const sessionId = recovery.find(
    (item: { referenceId: string }) => item.referenceId === 'TEST-RECOVERY',
  )?.sessionId
  expect(sessionId).toBeTruthy()
  expect(
    (await (await request.get(`${api}/api/projects`)).json()).some(
      (item: { referenceId: string }) => item.referenceId === 'TEST-RECOVERY',
    ),
  ).toBe(false)

  await page.reload()
  await expect(page.getByRole('heading', { name: 'Копии восстановления' })).toBeVisible()
  await page.getByRole('button', { name: 'Восстановить' }).last().click()
  await page.getByRole('button', { name: /Схема движения.*Размеры и вариант/ }).click()
  await expect(page.getByLabel('n100')).toHaveValue('100')
  await expect(page.getByLabel('n50')).toHaveValue('50')
  await expect(page.locator('.save-state')).toContainText('Неприменённый ввод')
  await page.getByRole('button', { name: 'Применить правки' }).click()
  await page.getByRole('button', { name: 'Сохранить локально' }).click()
  await expect(page.locator('.save-state')).toHaveText('Черновик сохранён')
  expect(
    (await (await request.get(`${api}/api/recovery`)).json()).some(
      (item: { sessionId: string }) => item.sessionId === sessionId,
    ),
  ).toBe(false)
  const saved = (await (await request.get(`${api}/api/projects`)).json()).find(
    (item: { referenceId: string }) => item.referenceId === 'TEST-RECOVERY',
  )
  expect(saved.revision).toBe(1)
  expect(
    (await (await request.get(`${api}/api/projects/${saved.id}`)).json()).scheme.parameters
      .signDistancesMetres,
  ).toMatchObject({ n100: 100, n50: 50 })
})

test('newer v1 JSON retains the zone fraction and resolves settlement markers', async ({
  page,
}) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto('/')
  await page.getByRole('button', { name: 'Открыть JSON' }).click()
  const fixture = readFileSync('tests/fixtures/legacy-v1-new-fields.json')
  await page.locator('#scheme-file').setInputFiles({
    name: 'anonymized-v1.json',
    mimeType: 'application/json',
    buffer: fixture,
  })
  await page.getByRole('button', { name: /Проверка и лист.*A4 для сверки/ }).click()
  await expect(page.locator('.print-host .placed-object')).toHaveCount(4)
  await expect(page.locator('.print-host .object-caption').first()).toContainText('100 м')
  await expect(page.locator('.print-host')).not.toContainText('{n100}')
  expect(errors).toEqual([])
})

test('imports synthetic station PU-66 and a generated PNG ZIP through the local API', async ({
  request,
  page,
}) => {
  const station = sampleCards[4]!
  const file = {
    name: station.filename,
    data: (await createSampleWorkbook(station)).toString('base64'),
  }
  const headers = { Origin: origin }
  const preview = await request.post(`${api}/api/pu66/import/preview`, {
    headers,
    data: { files: [file] },
  })
  expect(preview.ok()).toBe(true)
  const plan = await preview.json()
  expect(plan.added).toBe(1)
  const applied = await request.post(`${api}/api/pu66/import/apply`, {
    headers,
    data: { files: [file], expectedFingerprint: plan.fingerprint },
  })
  expect(applied.ok()).toBe(true)
  const image = new PNG({ width: 8, height: 8 })
  image.data.fill(255)
  const png = PNG.sync.write(image)
  const archive = Buffer.from(
    zipSync({ 'PNG с номером/1.25.png': png, 'PNG без номера/1.25.png': png }),
  )
  const signs = {
    archive: { name: 'synthetic.zip', data: archive.toString('base64') },
    documentCode: 'УЧЕБНЫЙ ИСТОЧНИК',
    edition: 'демо',
    pdf: null,
  }
  const signPreview = await request.post(`${api}/api/signs/import/preview`, {
    headers,
    data: signs,
  })
  expect(signPreview.ok()).toBe(true)
  const signPlan = await signPreview.json()
  const signApply = await request.post(`${api}/api/signs/import/apply`, {
    headers,
    data: { ...signs, expectedFingerprint: signPlan.fingerprint },
  })
  expect(signApply.ok()).toBe(true)
  await page.goto('/')
  await page.getByRole('button', { name: 'Реестры', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Локальные реестры' })).toBeVisible()
  expect((await (await request.get(`${api}/api/signs`)).json()).length).toBe(1)
  expect((await (await request.get(`${api}/api/pu66`)).json()).length).toBe(1)
})

test('A4 print contains exactly one page', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Открыть JSON' }).click()
  await page.locator('#scheme-file').setInputFiles({
    name: 'anonymized-v1.json',
    mimeType: 'application/json',
    buffer: readFileSync('tests/fixtures/legacy-v1-new-fields.json'),
  })
  await page.getByRole('button', { name: /Проверка и лист.*A4 для сверки/ }).click()
  await page.emulateMedia({ media: 'print' })
  await expect(page.locator('.print-host')).toHaveCSS('margin-top', '0px')
  const pdf = await page.pdf({ printBackground: true, preferCSSPageSize: true })
  expect(pdf.toString('latin1').match(/\/Type\s*\/Page\b/g) ?? []).toHaveLength(1)
})
