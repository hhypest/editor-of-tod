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
  await expect(page.locator('.print-host .dimension-label').nth(2)).toHaveText('18')
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

test('unverified B.34 regulation hint explains the prototype rules but cannot be applied', async ({
  page,
}) => {
  await page.goto('/')
  await page.getByLabel('Локальный идентификатор переезда').fill('TEST-ADVICE')
  await page.getByLabel('Фронт работ, м').fill('18')
  await page.getByLabel('Отвод, м').fill('15')
  await page.getByLabel('Буфер, м').fill('10')
  await page.getByLabel('Первая').fill('70')
  await page.getByLabel('Вторая').fill('50')
  await page.getByLabel('Третья').fill('40')
  await page.getByRole('button', { name: 'Создать проект' }).click()
  await page.getByRole('button', { name: /Схема движения.*Размеры и вариант/ }).click()
  const advice = page.locator('.advice')
  await expect(advice).toContainText('нет данных')
  await page.getByLabel('Интенсивность, авт./ч (по данным составителя)').fill('180')
  await expect(advice.getByRole('heading')).toContainText('не проверены')
  await expect(advice.getByRole('heading')).toContainText('знаки приоритета 2.6/2.7')
  await expect(advice.getByRole('button')).toHaveCount(0)
  await expect(page.getByLabel('Регулирование Б.34')).toHaveValue('auto')
  await page.getByLabel('Интенсивность, авт./ч (по данным составителя)').fill('300')
  await page.getByLabel('Прямой участок дороги').check()
  await expect(advice.getByRole('heading')).toContainText('один регулировщик')
  await expect(advice).toContainText('значение не проверено')
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

test('creates a project from a PU-66 card found by kilometre and picket', async ({
  request,
  page,
}) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  const files = await Promise.all(
    [sampleCards[0]!, sampleCards[1]!].map(async (card) => ({
      name: card.filename,
      data: (await createSampleWorkbook(card)).toString('base64'),
    })),
  )
  const headers = { Origin: origin }
  const preview = await request.post(`${api}/api/pu66/import/preview`, {
    headers,
    data: { files },
  })
  const plan = await preview.json()
  const applied = await request.post(`${api}/api/pu66/import/apply`, {
    headers,
    data: { files, expectedFingerprint: plan.fingerprint },
  })
  expect(applied.ok()).toBe(true)

  await page.goto('/')
  await page.getByLabel('Поиск карточки').fill('24 км 7 пк')
  await expect(page.getByText(/Найдено: 1 из \d+/)).toBeVisible()
  const choice = page.getByLabel('Локальная карточка')
  await choice.selectOption('90002:24:7')
  await expect(page.getByText('Будет закреплено в проекте')).toBeVisible()
  await expect(page.getByLabel('Локальный идентификатор переезда')).toHaveValue('90002:24:7')
  await page.getByLabel('Фронт работ, м').fill('18')
  await page.getByLabel('Отвод, м').fill('10')
  await page.getByLabel('Буфер, м').fill('10')
  await page.getByLabel('Первая').fill('70')
  await page.getByLabel('Вторая').fill('50')
  await page.getByLabel('Третья').fill('40')
  await page.getByRole('button', { name: 'Создать проект' }).click()
  await expect(page.getByText(/локальная редакция № 1/)).toBeVisible()
  await expect(page.locator('.opening-notes')).toContainText('Локальная карточка ПУ-66 закреплена')
  await expect(page.locator('.opening-notes')).not.toContainText('введён вручную')
  await page.getByRole('button', { name: /Проверка и лист.*A4 для сверки/ }).click()
  await expect(page.locator('.print-host')).toContainText('Учебная дорога Б')
  expect(errors).toEqual([])
})

test('leaving the form while the card is re-read cancels project creation', async ({ page }) => {
  let calls = 0
  let release: () => void = () => undefined
  const held = new Promise<void>((resolve) => (release = resolve))
  await page.route('**/api/pu66/*/scheme', async (route) => {
    calls += 1
    if (calls === 2) await held
    await route.continue()
  })
  await page.goto('/')
  await page.getByLabel('Поиск карточки').fill('24 км 7 пк')
  await page.getByLabel('Локальная карточка').selectOption('90002:24:7')
  await expect(page.getByText('Будет закреплено в проекте')).toBeVisible()
  await page.getByLabel('Фронт работ, м').fill('18')
  await page.getByLabel('Отвод, м').fill('10')
  await page.getByLabel('Буфер, м').fill('10')
  await page.getByLabel('Первая').fill('70')
  await page.getByLabel('Вторая').fill('50')
  await page.getByLabel('Третья').fill('40')
  await page.getByRole('button', { name: 'Создать проект' }).click()
  await expect.poll(() => calls).toBe(2)
  await page.getByRole('button', { name: 'Открыть JSON' }).click()
  release()
  await page.getByRole('button', { name: 'Новый проект' }).click()
  await expect(page.getByRole('alert')).toContainText('Создание проекта отменено')
  await expect(page.getByText(/локальная редакция № 1/)).toHaveCount(0)
})

test('release sheet drops the draft mark and downloads a PNG', async ({ page }) => {
  await page.goto('/')
  await page.getByLabel('Локальный идентификатор переезда').fill('TEST-RELEASE')
  await page.getByLabel('Фронт работ, м').fill('18')
  await page.getByLabel('Отвод, м').fill('10')
  await page.getByLabel('Буфер, м').fill('10')
  await page.getByLabel('Первая').fill('70')
  await page.getByLabel('Вторая').fill('50')
  await page.getByLabel('Третья').fill('40')
  await page.getByRole('button', { name: 'Создать проект' }).click()
  await page.getByRole('button', { name: /Проверка и лист.*A4 для сверки/ }).click()
  const host = page.locator('.print-host')
  await expect(host.locator('.draft-mark')).toHaveCount(1)
  await host.getByLabel(/Я проверил лист/).check()
  await expect(host.getByRole('heading', { name: 'Выпускной лист A4' })).toBeVisible()
  await expect(host.locator('.draft-mark')).toHaveCount(0)
  const download = page.waitForEvent('download')
  await host.getByRole('button', { name: 'Скачать PNG' }).click()
  const file = await download
  // Имя файла с кириллицей проверяется модульным тестом: Chromium в контейнере без русской
  // локали отдаёт его как «download».
  const bytes = readFileSync((await file.path())!)
  expect(bytes.subarray(1, 4).toString('latin1')).toBe('PNG')
  expect([bytes.readUInt32BE(16), bytes.readUInt32BE(20)]).toEqual([3528, 2495])
})

test('attaches standards, switches the sign catalog to a new edition and flags the old one', async ({
  page,
}) => {
  const pdf = (text: string) => Buffer.from(`%PDF-1.4\n${text}`)
  await page.goto('/')
  await page.getByRole('button', { name: 'Реестры', exact: true }).click()
  await page.getByRole('button', { name: 'Нормативные документы' }).click()
  const library = page.locator('.library')
  const addEdition = async (filename: string, text: string, effective: string) => {
    await library
      .locator('input[type="file"]')
      .setInputFiles({ name: filename, mimeType: 'application/pdf', buffer: pdf(text) })
    await library.getByLabel('Дата введения в действие').fill(effective)
    await library.getByRole('button', { name: 'Проверить документ' }).click()
  }
  await addEdition('GOST-R-99290-2024.pdf', 'edition 2024', '2024-06-01')
  await expect(library.getByLabel('Обозначение', { exact: true })).toHaveValue('ГОСТ Р 99290')
  await expect(library.getByLabel('Редакция', { exact: true })).toHaveValue('2024')
  await expect(library).toContainText('Станет действующей редакцией этого документа.')
  await library.getByRole('button', { name: /Добавить в библиотеку/ }).click()
  await expect(library).toContainText('ГОСТ Р 99290-2024 добавлен в библиотеку')
  await expect(library.locator('.status-current')).toContainText('Редакция 2024')

  // Каталог знаков по редакции 2024 из библиотеки.
  await page.getByRole('button', { name: 'Импорт Excel и знаков' }).click()
  const source = page.getByLabel('Документ из библиотеки')
  const option = await source
    .locator('option', { hasText: 'ГОСТ Р 99290-2024' })
    .getAttribute('value')
  await source.selectOption(option!)
  const image = new PNG({ width: 8, height: 8 })
  image.data.fill(120)
  const png = PNG.sync.write(image)
  await page.locator('input[type="file"][accept=".zip"]').setInputFiles({
    name: 'signs.zip',
    mimeType: 'application/zip',
    buffer: Buffer.from(zipSync({ 'PNG с номером/1.25.png': png, 'PNG без номера/1.25.png': png })),
  })
  await page.getByRole('button', { name: 'Просмотреть изменения знаков' }).click()
  await expect(page.getByText('Изменённые изображения')).toBeVisible()
  await page.getByRole('button', { name: 'Подтвердить каталог и создать копию SQLite' }).click()
  await expect(page.getByText(/Текущий набор: ГОСТ Р 99290, редакция 2024/)).toBeVisible()

  // Новая редакция уже введена: прежняя заменена, каталог знаков устарел.
  await page.getByRole('button', { name: 'Нормативные документы' }).click()
  await addEdition('GOST-R-99290-2026.pdf', 'edition 2026', '2026-01-01')
  await expect(library).toContainText('Станет действующей редакцией вместо ГОСТ Р 99290-2024')
  await library.getByRole('button', { name: /Добавить в библиотеку/ }).click()
  await expect(library.locator('.status-superseded')).toContainText('заменён редакцией 2026')
  await expect(library.locator('.warning').first()).toContainText(
    'Каталог знаков загружен по редакции 2024, а действует ГОСТ Р 99290-2026',
  )
  const [popup] = await Promise.all([
    page.waitForEvent('popup'),
    library.locator('.status-current').getByRole('link', { name: 'Открыть PDF' }).click(),
  ])
  await popup.close()
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
