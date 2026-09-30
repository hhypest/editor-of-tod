import { readFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'
import { zipSync } from 'fflate'
import { PNG } from 'pngjs'
import { createSampleWorkbook, sampleCards } from '../../scripts/generate-pu66-samples'
import { fictionalMethodology, fictionalSignStandard } from '../../server/__tests__/pdf-fixture'

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

test('B.34 regulation hint with unconfirmed parameters explains the rules but cannot be applied', async ({
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
  await expect(advice.getByRole('heading')).toContainText('неподтверждёнными параметрами')
  await expect(advice.getByRole('heading')).toContainText('знаки приоритета 2.6/2.7')
  await expect(advice.getByRole('button')).toHaveCount(0)
  await expect(page.getByLabel('Регулирование Б.34')).toHaveValue('auto')
  await page.getByLabel('Интенсивность, авт./ч (по данным составителя)').fill('300')
  await page.getByLabel('Прямой участок дороги').check()
  await expect(advice.getByRole('heading')).toContainText('один регулировщик')
  await expect(advice).toContainText('Не подтверждены: Интенсивность')
  await expect(advice).toContainText('«Нормативные параметры»')
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
  await page.getByText('Загрузка знаков из ZIP (прежний способ)').click()
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

test('extracts the sign catalog from the PDF of a standard in the library', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Реестры', exact: true }).click()
  await page.getByRole('button', { name: 'Нормативные документы' }).click()
  const library = page.locator('.library')
  await library.locator('input[type="file"]').setInputFiles({
    name: 'GOST-R-99291-2025.pdf',
    mimeType: 'application/pdf',
    buffer: fictionalSignStandard(),
  })
  await library.getByLabel(/^Назначение/).selectOption('signs')
  await library.getByLabel('Дата введения в действие').fill('2025-01-01')
  await library.getByRole('button', { name: 'Проверить документ' }).click()
  await library.getByRole('button', { name: /Добавить в библиотеку/ }).click()
  await expect(library).toContainText('ГОСТ Р 99291-2025 добавлен в библиотеку')

  await page.getByRole('button', { name: 'Импорт Excel и знаков' }).click()
  const box = page.locator('.pdf-signs')
  const source = box.locator('select')
  const option = await source
    .locator('option', { hasText: 'ГОСТ Р 99291-2025' })
    .getAttribute('value')
  await source.selectOption(option!)
  await box.getByRole('button', { name: 'Извлечь знаки из PDF' }).click()
  await expect(box).toContainText('Страницы 2–3: изображений 7')
  await expect(box).toContainText('У 1 изображений номер не найден')
  await expect(box).toContainText('п. 3.2: «Знаки 1.8, 1.15 - 1.16 допускается')
  await expect(box.locator('[data-key="2-3.2"]')).toContainText('1.34.1_v2')
  const missing = box.locator('[data-key="2-5"]')
  await missing.getByLabel('Номер').fill('1.33')
  await missing.getByLabel('Номер').blur()
  await expect(box).toContainText('Номера изменены')
  await expect(box.getByRole('button', { name: /Записать каталог/ })).toBeDisabled()
  await box.getByRole('button', { name: 'Проверить снова' }).click()
  await expect(missing).toContainText('1.33')
  await box.getByRole('button', { name: /Записать каталог/ }).click()
  await expect(box).toContainText('Каталог знаков записан по ГОСТ Р 99291-2025')
  await expect(
    page.getByText(/Текущий набор: ГОСТ Р 99291, редакция 2025, 10 знаков/),
  ).toBeVisible()
  await page.locator('#sign-search').fill('1.16_ж')
  await expect(page.locator('.gallery figcaption')).toHaveText(['1.16_ж'])
})

test('confirms a normative parameter from the text of an attached document', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Реестры', exact: true }).click()
  await page.getByRole('button', { name: 'Нормативные документы' }).click()
  const library = page.locator('.library')
  await library.locator('input[type="file"]').setInputFiles({
    name: 'odm-218.6.019-2026.pdf',
    mimeType: 'application/pdf',
    buffer: fictionalMethodology(520),
  })
  await expect(library.getByLabel('Обозначение', { exact: true })).toHaveValue('ОДМ 218.6.019')
  await library.getByLabel('Дата введения в действие').fill('2026-01-01')
  await library.getByRole('button', { name: 'Проверить документ' }).click()
  await library.getByRole('button', { name: /Добавить в библиотеку/ }).click()
  await expect(library).toContainText('добавлен в библиотеку')

  await page.getByRole('button', { name: 'Нормативные параметры' }).click()
  const box = page.locator('.parameters')
  const item = box.locator('[data-parameter="odm-signs-hourly"]')
  await expect(item).toContainText('ОДМ 218.6.019-2026, п. 5.4.4')
  await expect(item).toContainText('используется значение прототипа')
  await item.getByRole('button', { name: 'Проверить и подтвердить' }).click()
  await expect(item.locator('.quote')).toContainText('протяженностью менее 45 м')
  await expect(item).toContainText('Значение из текста: 260 авт/ч.')
  await expect(item.getByLabel('Значение, авт/ч')).toHaveValue('260')
  await expect(item.getByRole('button', { name: 'Подтвердить значение' })).toBeDisabled()
  await box.getByLabel('Кто подтверждает (для журнала)').fill('Учебный составитель')
  await item.getByRole('button', { name: 'Подтвердить значение' }).click()
  await expect(box).toContainText('подтверждено значение 260 авт/ч')
  await expect(item).toContainText('Подтверждено')
  await expect(item.locator('.value')).toHaveText('260 авт/ч')
  await expect(box).toContainText('Подтверждено 1 из 8')
})

test('opens help for the current screen, searches it and jumps by contents', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto('/')
  await page.getByRole('button', { name: 'Реестры', exact: true }).click()
  await page.getByRole('button', { name: 'Нормативные параметры' }).click()
  await page.getByRole('button', { name: 'Справка', exact: true }).first().click()
  await expect(page.getByRole('heading', { name: 'Справка', level: 1 })).toBeVisible()
  const parameters = page.locator('[data-help="parameters"]')
  await expect(parameters).toHaveClass(/current/)
  await expect(parameters.locator('.ui', { hasText: 'Подтвердить значение' })).toBeVisible()

  const help = page.locator('.help')
  await help.getByLabel('Поиск по справке').fill('сверки 30 января')
  await expect(help.getByRole('status')).toContainText('Найдено разделов')
  await expect(help.locator('[data-help="pu66"]')).toBeVisible()
  await expect(help.locator('[data-help="signs"]')).toHaveCount(0)
  await help
    .getByRole('navigation', { name: 'Оглавление справки' })
    .getByRole('button', { name: 'Этап 4. Проверка и лист A4' })
    .click()
  await expect(help.getByLabel('Поиск по справке')).toHaveValue('')
  await expect(help.locator('[data-help="stage-review"]')).toHaveClass(/current/)
  expect(errors).toEqual([])
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
