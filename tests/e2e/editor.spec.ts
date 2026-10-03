import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import { zipSync } from 'fflate'
import { PNG } from 'pngjs'
import { createSampleWorkbook, sampleCards } from '../../scripts/generate-pu66-samples'
import { fictionalMethodology, fictionalSignStandard } from '../../server/__tests__/pdf-fixture'
import { importSchemeJson } from '../../src/domain/import'
import { reviewScheme } from '../../src/domain/review-scheme'
import { setMark } from '../../src/domain/review-marks'

const api = 'http://127.0.0.1:4100'
const origin = 'http://127.0.0.1:5173'

/** Книги генерируются один раз: новая генерация отличается байтами и дала бы новую редакцию. */
let sampleFiles: Promise<Array<{ name: string; data: string }>> | undefined

/** Импортирует четыре вымышленные карточки ПУ-66; повторный вызов ничего не меняет. */
async function importSampleCards(request: APIRequestContext): Promise<void> {
  sampleFiles ??= Promise.all(
    sampleCards.slice(0, 4).map(async (card) => ({
      name: card.filename,
      data: (await createSampleWorkbook({ ...card, length: 40 })).toString('base64'),
    })),
  )
  const files = await sampleFiles
  const headers = { Origin: origin }
  const preview = await request.post(`${api}/api/pu66/import/preview`, {
    headers,
    data: { files },
  })
  expect(preview.ok()).toBe(true)
  const plan = await preview.json()
  if (!plan.added && !plan.updated) return
  const applied = await request.post(`${api}/api/pu66/import/apply`, {
    headers,
    data: { files, expectedFingerprint: plan.fingerprint },
  })
  expect(applied.ok()).toBe(true)
}

/** Вкладка «Новый проект»: при наличии сохранённых проектов стартовая вкладка — «Мои проекты». */
async function openNewProjectTab(page: Page): Promise<void> {
  await page
    .getByRole('group', { name: 'Способ открытия проекта' })
    .getByRole('button', { name: 'Новый проект' })
    .click()
}

/** Выбирает карточку ПУ-66 по км и пк и заполняет обязательные условия новой схемы. */
async function fillNewProject(
  page: Page,
  search: string,
  key: string,
  sizes = { taper: '10' },
  location: 'Вне населённого пункта' | 'В населённом пункте' = 'Вне населённого пункта',
): Promise<void> {
  await openNewProjectTab(page)
  await page.getByLabel('Поиск карточки').fill(search)
  await page.getByLabel('Локальная карточка').selectOption(key)
  await expect(page.getByText('Будет закреплено в проекте')).toBeVisible()
  await page.getByLabel('Фронт работ, м').fill('18')
  await page.getByLabel('Отвод, м').fill(sizes.taper)
  await page.getByLabel('Буфер, м').fill('10')
  await page.locator('[data-field="parameters.workConditions.kind"]:visible').selectOption('short')
  await page.locator('[data-field="parameters.workConditions.durationHours"]:visible').fill('5')
  await page
    .locator('[data-field="parameters.workConditions.daylight"]:visible')
    .selectOption('day')
  await page.locator('[data-field="parameters.workConditions.regulatorsPresent"]:visible').check()
  await page.getByLabel(location).check()
}

test('without PU-66 cards a new project cannot be started', async ({ page }) => {
  await page.route('**/api/pu66', (route) => route.fulfill({ json: [] }))
  await page.goto('/')
  await openNewProjectTab(page)
  const blocked = page.locator('.blocked')
  await expect(blocked).toContainText('начать новый проект невозможно')
  await expect(page.getByRole('button', { name: 'Создать проект' })).toHaveCount(0)
  await expect(page.getByLabel('Фронт работ, м')).toHaveCount(0)
  await blocked.getByRole('button', { name: 'Импортировать ПУ-66' }).click()
  await expect(page.getByRole('heading', { name: 'Локальные реестры' })).toBeVisible()

  await page.unroute('**/api/pu66')
  await page.route('**/api/pu66', (route) => route.abort())
  await page.reload()
  await openNewProjectTab(page)
  await expect(page.locator('.blocked')).toContainText('реестр ПУ-66 недоступен')
  await expect(page.getByRole('button', { name: 'Создать проект' })).toHaveCount(0)
})

test('recalculates the variant from the front and permits explicitly staffed signal replacement', async ({
  page,
  request,
}) => {
  await importSampleCards(request)
  await page.goto('/')
  await fillNewProject(page, '12 км 3 пк', '90001:12:3')
  await page.getByLabel('Фронт работ, м').fill('21,5')
  await expect(page.getByRole('status').filter({ hasText: 'По длине фронта' })).toContainText(
    'Б.34',
  )
  await page.getByRole('button', { name: 'Создать проект' }).click()
  await page.getByRole('button', { name: /Схема движения.*Размеры и вариант/ }).click()
  await page.getByLabel('Интенсивность, авт./ч (по данным составителя)').fill('249')
  await page.locator('[data-field="parameters.workConditions.sectionMetres"]:visible').fill('50')
  await expect(page.locator('.advice').getByRole('heading')).toContainText('два регулировщика')
  await page.locator('[data-field="parameters.workConditions.regulatorsPresent"]:visible').uncheck()
  await expect(page.locator('.advice')).toContainText('таблица предусматривает светофор')
  await page.locator('[data-field="parameters.workConditions.regulatorsPresent"]:visible').check()
  await page.getByLabel('Регулирование Б.34').selectOption('two')
  const front = page
    .getByRole('heading', { name: 'Зона Б.34', exact: true })
    .locator('..')
    .getByLabel('Фронт работ, м', { exact: true })
  await front.fill('31')
  await page.getByRole('button', { name: 'Применить правки' }).click()
  await expect(page.getByRole('heading', { name: 'Зона Б.33', exact: true })).toBeVisible()
  await page
    .getByRole('heading', { name: 'Зона Б.33', exact: true })
    .locator('..')
    .getByLabel('Фронт работ, м', { exact: true })
    .fill('21,5')
  await page.getByRole('button', { name: 'Применить правки' }).click()
  await expect(page.getByRole('heading', { name: 'Зона Б.34', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Взять фронт из п. 8 ПУ-66' }).click()
  await expect(
    page
      .getByRole('heading', { name: 'Зона Б.34', exact: true })
      .locator('..')
      .getByLabel('Фронт работ, м', { exact: true }),
  ).toHaveValue('40')
})

test('new project: form edits apply, review opens, and console stays clean', async ({
  page,
  request,
}) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await importSampleCards(request)
  await page.goto('/')
  await fillNewProject(page, '12 км 3 пк', '90001:12:3')
  await page.getByRole('button', { name: 'Создать проект' }).click()
  await page.getByRole('button', { name: /Схема движения.*Размеры и вариант/ }).click()
  await expect(page.getByRole('heading', { name: 'Размеры и параметры схемы' })).toBeVisible()
  await page.locator('[data-field="parameters.signDistancesMetres.d250"]').fill('240')
  await page.getByRole('button', { name: 'Применить правки' }).click()
  await page.getByRole('button', { name: /Проверка и лист.*A4 для сверки/ }).click()
  await expect(page.getByRole('heading', { name: 'Реквизиты листа и согласования' })).toBeVisible()
  await expect(page.locator('.print-host .dimension-label').nth(2)).toHaveText('18')
  expect(errors).toEqual([])
})

test('review findings move focus to the first empty field', async ({ page, request }) => {
  await importSampleCards(request)
  await page.goto('/')
  await fillNewProject(page, '36 км 1 пк', '90003:36:1', { taper: '8' })
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

  // Group findings have no field: navigation focuses the destination heading.
  await page.getByRole('button', { name: /Проверка и лист.*A4 для сверки/ }).click()
  await page
    .locator('li', { hasText: 'Размерная цепочка рисунка' })
    .getByRole('link', { name: 'Перейти' })
    .click()
  await expect(page.locator('#details-title')).toBeFocused()
  await page.getByRole('button', { name: /Проверка и лист.*A4 для сверки/ }).click()
  await page
    .locator('li', { hasText: 'Условия движения для Б.34' })
    .getByRole('link', { name: 'Перейти' })
    .click()
  await expect(page.locator('#placements-title')).toBeFocused()

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
  request,
}) => {
  await importSampleCards(request)
  await page.goto('/')
  await fillNewProject(page, '12 км 3 пк', '90001:12:3', { taper: '15' })
  await page.getByRole('button', { name: 'Создать проект' }).click()
  await page.getByRole('button', { name: /Схема движения.*Размеры и вариант/ }).click()
  const advice = page.locator('.advice')
  await expect(advice).toContainText('требуется проверка условий')
  await page.getByLabel('Интенсивность, авт./ч (по данным составителя)').fill('180')
  await expect(advice.getByRole('heading')).toContainText('неподтверждёнными параметрами')
  await expect(advice.getByRole('heading')).toContainText('знаки приоритета 2.6/2.7')
  await expect(advice.getByRole('button')).toHaveCount(0)
  await expect(page.getByLabel('Регулирование Б.34')).toHaveValue('auto')
  await page.getByLabel('Интенсивность, авт./ч (по данным составителя)').fill('300')
  await page.getByLabel('Прямой участок; регулировщик виден с обоих концов рабочей зоны').check()
  await expect(advice.getByRole('heading')).toContainText('один регулировщик')
  await expect(advice).toContainText('Не подтверждены: Наибольшая продолжительность')
  await expect(advice).toContainText('«Нормативные параметры»')
  await page.getByLabel('Интенсивность, авт./ч (по данным составителя)').fill('501')
  await expect(advice.getByRole('heading')).toContainText('требуется проверка условий')
  await expect(advice).toContainText('выходит за условия таблицы')
  await page.getByLabel('Интенсивность, авт./ч (по данным составителя)').fill('180')
  await page
    .getByRole('heading', { name: 'Зона Б.34', exact: true })
    .locator('..')
    .getByLabel('Фронт работ, м', { exact: true })
    .fill('25')
  await expect(advice.getByRole('heading')).toContainText('два регулировщика')
  await page.getByLabel('Регулирование Б.34').selectOption('signs')
  await page.getByRole('button', { name: 'Применить правки' }).click()
  await page.getByRole('button', { name: /Проверка и лист.*A4 для сверки/ }).click()
  await expect(
    page.locator('li', { hasText: 'Условия движения для Б.34' }).getByLabel('Проверено'),
  ).toBeDisabled()
})

test('restores applied edits and unapplied fields after the window closes', async ({
  page,
  request,
}) => {
  await importSampleCards(request)
  await page.goto('/')
  await fillNewProject(page, '48 км 5 пк', '90004:48:5', undefined, 'В населённом пункте')
  await page.getByRole('button', { name: 'Создать проект' }).click()
  await page.getByRole('button', { name: /Схема движения.*Размеры и вариант/ }).click()
  const n100 = page.locator('[data-field="parameters.signDistancesMetres.n100"]')
  const n50 = page.locator('[data-field="parameters.signDistancesMetres.n50"]')
  await n100.fill('90')
  await page.getByRole('button', { name: 'Применить правки' }).click()
  await n50.fill('45')
  await expect(page.locator('.save-state')).toContainText('копия восстановления записана')

  const recovery = await (await request.get(`${api}/api/recovery`)).json()
  const sessionId = recovery.find(
    (item: { referenceId: string }) => item.referenceId === '90004:48:5',
  )?.sessionId
  expect(sessionId).toBeTruthy()
  expect(
    (await (await request.get(`${api}/api/projects`)).json()).some(
      (item: { referenceId: string }) => item.referenceId === '90004:48:5',
    ),
  ).toBe(false)

  await page.reload()
  await expect(page.getByRole('heading', { name: 'Копии восстановления' })).toBeVisible()
  await page
    .locator('li', { hasText: '90004:48:5' })
    .getByRole('button', { name: 'Восстановить' })
    .click()
  await page.getByRole('button', { name: /Схема движения.*Размеры и вариант/ }).click()
  await expect(n100).toHaveValue('90')
  await expect(n50).toHaveValue('45')
  await expect(page.locator('.save-state')).toContainText('Неприменённый ввод')
  await page.getByRole('button', { name: 'Применить правки' }).click()
  await page.getByRole('button', { name: 'Сохранить проект' }).click()
  await expect(page.locator('.save-state')).toHaveText('Сохранён')
  expect(
    (await (await request.get(`${api}/api/recovery`)).json()).some(
      (item: { sessionId: string }) => item.sessionId === sessionId,
    ),
  ).toBe(false)
  const saved = (await (await request.get(`${api}/api/projects`)).json()).find(
    (item: { referenceId: string }) => item.referenceId === '90004:48:5',
  )
  expect(saved.revision).toBe(1)
  expect(
    (await (await request.get(`${api}/api/projects/${saved.id}`)).json()).scheme.parameters
      .signDistancesMetres,
  ).toMatchObject({ n100: 90, n50: 45 })
})

test('two windows protect a live copy, transfer it after closing and send the legacy source only once', async ({
  page,
  context,
  request,
}) => {
  const scheme = importSchemeJson(readFileSync('tests/fixtures/manual-v1.json', 'utf8')).scheme
  const fileName = `two-windows-${randomUUID()}.json`
  const writes: Array<Record<string, unknown>> = []
  page.on('request', (call) => {
    if (call.method() === 'PUT' && call.url().includes('/api/recovery/'))
      writes.push(call.postDataJSON())
  })
  await page.goto('/')
  await page.getByRole('button', { name: 'Открыть файл', exact: true }).click()
  await page.locator('#scheme-file').setInputFiles({
    name: fileName,
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(scheme)),
  })
  await page.getByRole('button', { name: /Схема движения.*Размеры и вариант/ }).click()
  const field = page.locator('[data-field="parameters.approachSpeedKmh"]')
  await field.fill('45')
  await field.blur()
  await expect(page.locator('.save-state')).toContainText('копия восстановления записана')
  await field.fill('46')
  await field.blur()
  await expect.poll(() => writes.length).toBe(2)
  await expect(page.locator('.save-state')).toContainText('копия восстановления записана')
  const firstScheme = writes[0]!.scheme as typeof scheme
  expect(firstScheme.source).toHaveProperty('originalJson')
  expect(writes[1]!.sourceSha256).toMatch(/^[a-f0-9]{64}$/)
  expect((writes[1]!.scheme as typeof scheme).source).not.toHaveProperty('originalJson')
  const list = await (await request.get(`${api}/api/recovery`)).json()
  const copy = list.find((item: { fileName: string }) => item.fileName === fileName)
  const second = await context.newPage()
  await second.goto('/')
  const row = second.locator('li', { hasText: fileName })
  await expect(row).toContainText('открыта в другом окне')
  await expect(row.getByRole('button', { name: 'Восстановить', exact: true })).toBeDisabled()
  await expect(row.getByRole('button', { name: 'Удалить копию', exact: true })).toBeDisabled()
  expect((await request.get(`${api}/api/recovery/${copy.sessionId}`)).status()).toBe(409)
  expect(
    (
      await request.post(`${api}/api/recovery/${copy.sessionId}/claim`, {
        headers: { Origin: origin },
        data: { ownerId: randomUUID(), expectedVersion: copy.version },
      })
    ).status(),
  ).toBe(409)
  // Navigation closes the old editor lifecycle and sends the same release as a normal reload.
  await page.reload()
  await expect
    .poll(async () => {
      const records = await (await request.get(`${api}/api/recovery`)).json()
      return records.find((item: { sessionId: string }) => item.sessionId === copy.sessionId)
        ?.active
    })
    .toBe(false)
  await second.reload()
  await row.getByRole('button', { name: 'Восстановить', exact: true }).click()
  await second.getByRole('button', { name: /Схема движения.*Размеры и вариант/ }).click()
  await expect(second.locator('[data-field="parameters.approachSpeedKmh"]')).toHaveValue('46')
  await expect(second.locator('.save-state')).toContainText('копия восстановления записана')
  await page.reload()
  const transferred = page.locator('li', { hasText: fileName })
  await expect(transferred).toContainText('открыта в другом окне')
  await expect(
    transferred.getByRole('button', { name: 'Восстановить', exact: true }),
  ).toBeDisabled()
  await second.close()
})

test('cancelled JSON download retains the recovery copy and unsaved state', async ({
  page,
  request,
}) => {
  await importSampleCards(request)
  await page.goto('/')
  await fillNewProject(page, '24 км 7 пк', '90002:24:7')
  await page.getByRole('button', { name: 'Создать проект' }).click()
  await expect(page.locator('.save-state')).toContainText('Копия восстановления записана')
  const before = await (await request.get(`${api}/api/recovery`)).json()
  await page.getByText('Действия с проектом', { exact: true }).click()
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Скачать файл проекта (JSON)' }).click()
  await (await download).cancel()
  await expect(page.locator('.save-state')).toContainText('сохраните редакцию')
  expect(await (await request.get(`${api}/api/recovery`)).json()).toEqual(before)
  // Пока копия не записана, даже после экспорта сохраняется предупреждение при закрытии.
  await page.route('**/api/recovery/**', (route) => route.abort())
  await page.getByRole('button', { name: /Схема движения.*Размеры и вариант/ }).click()
  await page.locator('[data-field="parameters.signDistancesMetres.d50"]').fill('45')
  await page.getByRole('button', { name: 'Применить правки' }).click()
  await expect(page.locator('.save-state')).toContainText('Копия восстановления не записана')
  const secondDownload = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Скачать файл проекта (JSON)' }).click()
  await (await secondDownload).cancel()
  expect(
    await page.evaluate(() => {
      const event = new Event('beforeunload', { cancelable: true })
      window.dispatchEvent(event)
      return event.defaultPrevented
    }),
  ).toBe(true)
})

test('newer v1 JSON retains the zone fraction and resolves settlement markers', async ({
  page,
}) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto('/')
  await page.getByRole('button', { name: 'Открыть файл' }).click()
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
  expect(
    (await (await request.get(`${api}/api/pu66`)).json()).some((card: { referenceId: string }) =>
      card.referenceId.startsWith('ст.'),
    ),
  ).toBe(true)
})

test('creates a project from a PU-66 card found by kilometre and picket', async ({
  request,
  page,
}) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await importSampleCards(request)

  await page.goto('/')
  await openNewProjectTab(page)
  await expect(page.getByRole('button', { name: 'Создать проект' })).toBeDisabled()
  await page.getByLabel('Поиск карточки').fill('24 км 7 пк')
  await expect(page.getByText(/Найдено: 1 из \d+/)).toBeVisible()
  const choice = page.getByLabel('Локальная карточка')
  await choice.selectOption('90002:24:7')
  await expect(page.getByText('Будет закреплено в проекте')).toBeVisible()
  await expect(page.locator('#new-scheme-title ~ form .preview')).toContainText('90002:24:7')
  // Без выбора местоположения проект не создаётся: от него зависят нормативные значения.
  await expect(page.getByRole('button', { name: 'Создать проект' })).toBeDisabled()
  await page.getByLabel('В населённом пункте').check()
  await expect(page.getByLabel('Разрешённая скорость на подходе, км/ч')).toHaveValue('60')
  await expect(page.getByLabel('Скорость в зоне работ, км/ч')).toHaveValue('40')
  await expect(page.getByRole('button', { name: 'Создать проект' })).toBeEnabled()
  await page.getByLabel('Фронт работ, м').fill('18')
  await page.getByLabel('Отвод, м').fill('10')
  await page.getByLabel('Буфер, м').fill('10')
  await page.locator('[data-field="parameters.workConditions.kind"]:visible').selectOption('short')
  await page.locator('[data-field="parameters.workConditions.durationHours"]:visible').fill('5')
  await page
    .locator('[data-field="parameters.workConditions.daylight"]:visible')
    .selectOption('day')
  await page.locator('[data-field="parameters.workConditions.regulatorsPresent"]:visible').check()
  await page.getByLabel('Вне населённого пункта').check()
  // Скорость и ступени пересчитаны для нового местоположения: 90 → 70 → 50 → 40.
  await expect(page.getByLabel('Разрешённая скорость на подходе, км/ч')).toHaveValue('90')
  await expect(page.getByLabel('Первая ступень 3.24')).toHaveValue('70')
  await expect(page.getByLabel('Вторая ступень 3.24')).toHaveValue('50')
  await page.getByRole('button', { name: 'Создать проект' }).click()
  const cards = await (await request.get(`${api}/api/pu66`)).json()
  const card = cards.find((item: { referenceId: string }) => item.referenceId === '90002:24:7')
  await expect(
    page.getByText(`локальная редакция № ${card.revision}`, { exact: false }),
  ).toBeVisible()
  await expect(page.locator('.opening-notes')).toContainText('Локальная карточка ПУ-66 закреплена')
  await expect(page.locator('.opening-notes')).not.toContainText('введён вручную')
  await page.getByRole('button', { name: /Проверка и лист.*A4 для сверки/ }).click()
  await expect(page.locator('.print-host')).toContainText('Учебная дорога Б')
  expect(errors).toEqual([])
})

test('leaving the form while the card is re-read cancels project creation', async ({
  page,
  request,
}) => {
  await importSampleCards(request)
  let calls = 0
  let release: () => void = () => undefined
  const held = new Promise<void>((resolve) => (release = resolve))
  await page.route('**/api/pu66/*/scheme', async (route) => {
    calls += 1
    if (calls === 2) await held
    await route.continue()
  })
  await page.goto('/')
  await openNewProjectTab(page)
  await page.getByLabel('Поиск карточки').fill('24 км 7 пк')
  await page.getByLabel('Локальная карточка').selectOption('90002:24:7')
  await expect(page.getByText('Будет закреплено в проекте')).toBeVisible()
  await page.getByLabel('Фронт работ, м').fill('18')
  await page.getByLabel('Отвод, м').fill('10')
  await page.getByLabel('Буфер, м').fill('10')
  await page.locator('[data-field="parameters.workConditions.kind"]:visible').selectOption('short')
  await page.locator('[data-field="parameters.workConditions.durationHours"]:visible').fill('5')
  await page
    .locator('[data-field="parameters.workConditions.daylight"]:visible')
    .selectOption('day')
  await page.locator('[data-field="parameters.workConditions.regulatorsPresent"]:visible').check()
  await page.getByLabel('Вне населённого пункта').check()
  await page.getByRole('button', { name: 'Создать проект' }).click()
  await expect.poll(() => calls).toBe(2)
  await page.getByRole('button', { name: 'Открыть файл' }).click()
  release()
  await page.getByRole('button', { name: 'Новый проект' }).click()
  await expect(page.getByRole('alert')).toContainText('Создание проекта отменено')
  await expect(page.getByText(/локальная редакция № 1/)).toHaveCount(0)
})

test('release sheet drops the draft mark and downloads a PNG', async ({ page, request }) => {
  await importSampleCards(request)
  await page.goto('/')
  await fillNewProject(page, '12 км 3 пк', '90001:12:3')
  await page.getByRole('button', { name: 'Создать проект' }).click()
  await page.getByRole('button', { name: /Схема движения.*Размеры и вариант/ }).click()
  await page.getByLabel('Регулирование Б.34').selectOption('two')
  await page.getByLabel('Интенсивность, авт./ч (по данным составителя)').fill('300')
  await page.getByRole('button', { name: 'Применить правки' }).click()
  await page.getByRole('button', { name: /Знаки и объекты.*Поле и свойства/ }).click()
  await page.getByRole('button', { name: 'Добавить конус' }).click()
  await page.getByRole('button', { name: 'Применить объект' }).click()
  await page.getByRole('button', { name: /Проверка и лист.*A4 для сверки/ }).click()
  const host = page.locator('.print-host')
  await expect(host.locator('.draft-mark')).toHaveCount(1)
  // Выпуск недоступен, пока не отмечены пункты «Проверить вручную».
  await expect(host.getByLabel(/Я проверил лист/)).toBeDisabled()
  await expect(host).toContainText('не отмечены пункты «Проверить вручную»')
  const checks = page.locator('.checks li')
  const total = await checks.count()
  expect(total).toBeGreaterThan(1)
  for (let index = 0; index < total; index++) {
    await checks.nth(index).getByLabel('Проверено').check()
    await expect(checks.nth(index)).toHaveClass(/marked/)
  }
  await expect(page.getByRole('heading', { name: /отмечено (\d+) из \1/ })).toBeVisible()
  // Снятая отметка снова закрывает выпуск.
  await checks.last().getByLabel('Проверено').uncheck()
  await expect(host.getByLabel(/Я проверил лист/)).toBeDisabled()
  await checks.last().getByLabel('Проверено').check()
  await host.getByLabel(/Я проверил лист/).check()
  await expect(host.getByRole('heading', { name: 'Выпускной лист A4' })).toBeVisible()
  await expect(host.locator('.draft-mark')).toHaveCount(0)
  await page.evaluate(() => window.dispatchEvent(new Event('beforeprint')))
  await expect(host).toHaveClass(/native-print-blocked/)
  await page.emulateMedia({ media: 'print' })
  await expect(host.locator('.preview-scroll')).toBeHidden()
  await expect(host.locator('.native-print-note')).toBeVisible()
  await page.evaluate(() => window.dispatchEvent(new Event('afterprint')))
  await page.emulateMedia({ media: 'screen' })
  // The checked print button obtains a one-use permit; subsequent native print has none.
  await page.evaluate(() => {
    window.print = () => {
      window.dispatchEvent(new Event('beforeprint'))
    }
  })
  await host.getByRole('button', { name: 'Печать листа A4' }).click()
  await expect(host).not.toHaveClass(/native-print-blocked/)
  await page.evaluate(() => window.dispatchEvent(new Event('beforeprint')))
  await expect(host).toHaveClass(/native-print-blocked/)
  await page.evaluate(() => window.dispatchEvent(new Event('afterprint')))
  const download = page.waitForEvent('download')
  await host.getByRole('button', { name: 'Скачать PNG' }).click()
  const file = await download
  // Имя файла с кириллицей проверяется модульным тестом: Chromium в контейнере без русской
  // локали отдаёт его как «download».
  const bytes = readFileSync((await file.path())!)
  expect(bytes.subarray(1, 4).toString('latin1')).toBe('PNG')
  expect([bytes.readUInt32BE(16), bytes.readUInt32BE(20)]).toEqual([3528, 2495])
  // Another process excluded the source after this page loaded. Output must recheck it,
  // cancel the release download and show the same new status in the shared checklist.
  await page.route('**/api/pu66/**/status', (route) =>
    route.fulfill({
      json: {
        referenceId: '90001:12:3',
        excluded: true,
        successorKey: null,
        event: {
          id: 901,
          action: 'exclude',
          date: '2026-10-02',
          actor: 'Учебный составитель',
          reason: 'closed',
          comment: 'Учебное исключение перед выпуском',
          successorKey: null,
          cardRevision: 1,
          recordedAt: '2026-10-02T10:00:00.000Z',
        },
      },
    }),
  )
  let unexpectedDownloads = 0
  page.on('download', () => unexpectedDownloads++)
  await host.getByRole('button', { name: 'Скачать PNG' }).click()
  await expect(host.getByRole('alert')).toContainText('Статус карточки изменился')
  await expect(page.locator('[data-check="pu66-status"]')).toContainText(
    'Учебное исключение перед выпуском',
  )
  await expect(host.locator('.draft-mark')).toHaveCount(1)
  expect(unexpectedDownloads).toBe(0)
})

test('release requires distances, objects, location and type size but allows paper requisites', async ({
  page,
}) => {
  const png = new PNG({ width: 8, height: 8 })
  png.data.fill(255)
  await page.route('**/api/signs', (route) =>
    route.fulfill({ json: [{ code: '1.25', width: 8, height: 8, revision: 1 }] }),
  )
  await page.route('**/api/signs/catalog', (route) =>
    route.fulfill({ json: { documentCode: 'УЧЕБНЫЙ', edition: 'демо', id: 1 } }),
  )
  await page.route('**/api/signs/1.25/image?rev=1', (route) =>
    route.fulfill({ contentType: 'image/png', body: PNG.sync.write(png) }),
  )
  await page.route('**/api/signs/1.25/metadata?rev=1', (route) =>
    route.fulfill({ json: { code: '1.25', revision: 1, width: 8, height: 8 } }),
  )
  const base = importSchemeJson(
    readFileSync('tests/fixtures/legacy-b34-manual.json', 'utf8'),
  ).scheme
  base.parameters.regulation = { ...base.parameters.regulation, mode: 'two', hourly: '300' }
  base.parameters.workConditions = {
    kind: 'short',
    durationHours: 5,
    daylight: 'day',
    regulatorsPresent: true,
    sectionMetres: null,
  }
  base.parameters.workZones.b34 = {
    ...base.parameters.workZones.b34!,
    workMetres: 18,
    taperMetres: 10,
    bufferMetres: 10,
  }
  const originalPost = base.placements.find((p) => p.kind === 'sign-post')!
  for (const variant of ['distance', 'objects', 'location', 'type-out', 'type-in', 'ready']) {
    let scheme = {
      ...base,
      parameters: {
        ...base.parameters,
        location:
          variant === 'location'
            ? ('auto' as const)
            : variant === 'type-in'
              ? ('in' as const)
              : ('out' as const),
        signSize: variant.startsWith('type-') ? ('auto' as const) : ('II' as const),
        signDistancesMetres: {
          ...base.parameters.signDistancesMetres,
          d50: variant === 'distance' ? null : 50,
        },
      },
      placements:
        variant === 'objects'
          ? []
          : [
              {
                ...originalPost,
                signIds: ['1.25'],
                distanceLabel: '{d50}',
                position: { ...originalPost.position, anchor: 'abs' as const, offsetXSvg: 300 },
              },
            ],
      signImages: {
        catalog: { documentCode: 'УЧЕБНЫЙ', edition: 'демо', id: 1 },
        revisions: { '1.25': 1 },
      },
      reviewMarks: {},
    }
    const findings = reviewScheme(scheme)
    for (const finding of findings.filter((f) => f.kind === 'verify'))
      scheme = setMark(scheme, findings, finding.id, true) as typeof scheme
    await page.goto('/')
    await page
      .getByRole('group', { name: 'Способ открытия проекта' })
      .getByRole('button', { name: 'Открыть файл' })
      .click()
    await page.locator('#scheme-file').setInputFiles({
      name: 'synthetic-release.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(scheme)),
    })
    await page.getByRole('button', { name: /Проверка и лист.*A4 для сверки/ }).click()
    const host = page.locator('.print-host')
    const release = host.getByLabel(/Я проверил лист/)
    if (variant === 'ready') {
      await expect(release).toBeEnabled()
      await release.check()
      await expect(host.locator('.draft-mark')).toHaveCount(0)
      const download = page.waitForEvent('download')
      await host.getByRole('button', { name: 'Скачать PNG' }).click()
      expect((await download).suggestedFilename()).not.toContain('черновик')
    } else {
      await expect(release).toBeDisabled()
      await expect(host.locator('.draft-mark')).toHaveCount(1)
    }
  }
})

test('pinned PNG proportions follow each project and ignore an older delayed response', async ({
  page,
}) => {
  page.on('dialog', (dialog) => dialog.accept())
  let activeRevision = 2
  await page.route('**/api/signs', (route) =>
    route.fulfill({ json: [{ code: '1.25', width: 10, height: 10, revision: activeRevision }] }),
  )
  await page.route('**/api/signs/catalog', (route) =>
    route.fulfill({ json: { id: 2, documentCode: 'УЧЕБНЫЙ', edition: '2026' } }),
  )
  await page.route('**/api/signs/1.25/metadata?rev=1', (route) =>
    route.fulfill({ json: { code: '1.25', revision: 1, width: 16, height: 8 } }),
  )
  await page.route('**/api/signs/1.25/metadata?rev=2', (route) =>
    route.fulfill({ json: { code: '1.25', revision: 2, width: 8, height: 16 } }),
  )
  await page.route('**/api/signs/1.25/metadata?rev=99', (route) =>
    route.fulfill({ status: 404, json: { error: 'Нет редакции' } }),
  )
  const releaseOld: Array<() => void> = []
  await page.route('**/api/signs/1.25/metadata?rev=3', async (route) => {
    await new Promise<void>((resolve) => {
      releaseOld.push(resolve)
    })
    await route.fulfill({ json: { code: '1.25', revision: 3, width: 200, height: 1 } })
  })
  await page.route('**/api/signs/1.25/image?*', (route) => {
    const revision = Number(new URL(route.request().url()).searchParams.get('rev'))
    const image = new PNG({ width: revision === 1 ? 16 : 8, height: revision === 1 ? 8 : 16 })
    image.data.fill(200)
    return route.fulfill({ contentType: 'image/png', body: PNG.sync.write(image) })
  })
  const base = importSchemeJson(
    readFileSync('tests/fixtures/legacy-b34-manual.json', 'utf8'),
  ).scheme
  const post = base.placements.find((item) => item.kind === 'sign-post')!
  const open = async (revision: number) => {
    const scheme = {
      ...base,
      id: randomUUID(),
      placements: [
        { ...post, signIds: ['1.25'], position: { anchor: 'abs', offsetXSvg: 300, offsetYSvg: 0 } },
      ],
      signImages: {
        catalog: { documentCode: 'УЧЕБНЫЙ', edition: '2024', id: 1 },
        revisions: { '1.25': revision },
      },
    }
    await page.getByRole('button', { name: 'Мои проекты', exact: true }).first().click()
    await page
      .getByRole('group', { name: 'Способ открытия проекта' })
      .getByRole('button', { name: 'Открыть файл' })
      .click()
    await page.locator('#scheme-file').setInputFiles({
      name: `history-${revision}.json`,
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(scheme)),
    })
    await expect(page.getByText(`history-${revision}.json`, { exact: true })).toBeVisible()
    await page.getByRole('button', { name: /Проверка и лист.*A4 для сверки/ }).click()
  }
  await page.goto('/')
  await open(1)
  const host = page.locator('.print-host:not(.thumbnail)')
  const ratio = () =>
    host
      .locator('image[data-sign-code="1.25"]')
      .first()
      .evaluate(
        (image) => Number(image.getAttribute('width')) / Number(image.getAttribute('height')),
      )
  await expect.poll(ratio).toBeCloseTo(2)
  await host.evaluate((element) => {
    ;(element as HTMLElement).dataset.continuity = 'same-component'
  })
  const repin = async (revision: number) => {
    activeRevision = revision
    await page.getByRole('button', { name: /Знаки и объекты.*Поле и свойства/ }).click()
    await page.getByRole('button', { name: 'Закрепить редакции PNG' }).click()
    await expect(page.getByText('Закреплены редакции 1 кодов PNG. Сохраните проект.')).toBeVisible()
    await page.getByRole('button', { name: /Проверка и лист.*A4 для сверки/ }).click()
  }
  await repin(2)
  await expect(host).toHaveAttribute('data-continuity', 'same-component')
  await expect.poll(ratio).toBeCloseTo(0.5)
  await open(2)
  await expect.poll(ratio).toBeCloseTo(0.5)
  await repin(3)
  await expect.poll(() => releaseOld.length).toBeGreaterThan(0)
  await repin(2)
  await expect.poll(ratio).toBeCloseTo(0.5)
  const oldResponse = page.waitForResponse('**/api/signs/1.25/metadata?rev=3')
  releaseOld.splice(0).forEach((resolve) => resolve())
  await oldResponse
  await expect.poll(ratio).toBeCloseTo(0.5)
  await open(99)
  await expect(host.locator('[data-missing-sign="1.25"]')).toBeVisible()
  const downloads: string[] = []
  page.on('download', (download) => downloads.push(download.suggestedFilename()))
  await host.getByRole('button', { name: 'Скачать PNG' }).click()
  await expect(host.getByRole('alert')).toContainText('нет PNG: 1.25')
  expect(downloads).toEqual([])
})

test('attaches standards, switches the sign catalog to a new edition and flags the old one', async ({
  page,
}) => {
  const pdf = (text: string) => Buffer.from(`%PDF-1.4\n${text}`)
  await page.goto('/')
  await page.getByRole('button', { name: 'Реестры', exact: true }).click()
  await page.getByRole('button', { name: 'Нормативные документы' }).click()
  const library = page.locator('.library')
  const addEdition = async (filename: string, text: string, effective: string, kind = 'signs') => {
    await library
      .locator('input[type="file"]')
      .setInputFiles({ name: filename, mimeType: 'application/pdf', buffer: pdf(text) })
    await library.getByRole('button', { name: 'Использовать сведения из имени файла' }).click()
    await library.getByLabel('Назначение').selectOption(kind)
    await library.getByLabel('Дата введения в действие').fill(effective)
    await library.getByRole('button', { name: 'Проверить документ' }).click()
  }
  await addEdition('GOST-R-99289-2024.pdf', 'rules only', '2024-01-01', 'rules')
  await library.getByRole('button', { name: /Добавить в библиотеку/ }).click()
  await expect(library).toContainText('ГОСТ Р 99289-2024 добавлен в библиотеку')
  await addEdition('GOST-R-99290-2024.pdf', 'edition 2024', '2024-06-01')
  await expect(library.getByLabel('Обозначение', { exact: true })).toHaveValue('ГОСТ Р 99290')
  await expect(library.getByLabel('Редакция', { exact: true })).toHaveValue('2024')
  await expect(library).toContainText('Станет действующей редакцией этого документа.')
  await library.getByRole('button', { name: /Добавить в библиотеку/ }).click()
  await expect(library).toContainText('ГОСТ Р 99290-2024 добавлен в библиотеку')
  await expect(
    library.locator('.status-current').filter({ hasText: 'Изображения знаков' }),
  ).toContainText('Редакция 2024')

  // Каталог знаков по редакции 2024 из библиотеки.
  await page.getByRole('button', { name: 'Импорт Excel и знаков' }).click()
  await page.getByText('Загрузка знаков из ZIP (прежний способ)').click()
  const source = page.getByLabel('Документ из библиотеки')
  await expect(source.locator('option', { hasText: 'ГОСТ Р 99289-2024' })).toHaveCount(0)
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
  await expect(page.getByText(/(?:Новые|Изменённые) изображения/).first()).toBeVisible()
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
    library
      .locator('.status-current')
      .filter({ hasText: 'Изображения знаков' })
      .getByRole('link', { name: 'Открыть PDF' })
      .click(),
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
  await library.getByRole('button', { name: 'Использовать сведения из имени файла' }).click()
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
  await library.getByRole('button', { name: 'Использовать сведения из имени файла' }).click()
  await expect(library.getByLabel('Обозначение', { exact: true })).toHaveValue('ОДМ 218.6.019')
  await library.getByLabel('Дата введения в действие').fill('2026-01-01')
  await library.getByRole('button', { name: 'Проверить документ' }).click()
  await library.getByRole('button', { name: /Добавить в библиотеку/ }).click()
  await expect(library).toContainText('добавлен в библиотеку')

  await page.getByRole('button', { name: 'Нормативные параметры' }).click()
  const box = page.locator('.parameters')
  const item = box.locator('[data-parameter="odm-signs-hourly"]')
  await expect(item).toContainText('ОДМ 218.6.019-2026, п. 6.4.4')
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
  await expect(box).toContainText('Подтверждено 1 из 16')
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

test('downloads a diagnostics file without card data', async ({ page, request }) => {
  await importSampleCards(request)
  await page.goto('/')
  await fillNewProject(page, '24 км 7 пк', '90002:24:7')
  await page.getByRole('button', { name: 'Создать проект' }).click()
  await page.getByRole('button', { name: 'Реестры', exact: true }).click()
  await page.getByRole('button', { name: 'Диагностика' }).click()
  const panel = page.locator('.diagnostics')
  await expect(panel).toContainText('карточек ПУ-66')
  const download = page.waitForEvent('download')
  await panel.getByRole('button', { name: 'Скачать диагностику' }).click()
  const file = await download
  const report = JSON.parse(readFileSync((await file.path())!, 'utf8'))
  expect(report.kind).toBe('editor-of-tod-diagnostics')
  expect(report.interface.project).toMatchObject({ open: true, template: 'Б.34' })
  expect(report.browser.userAgent).toBeTruthy()
  const text = JSON.stringify(report)
  for (const secret of ['90002', 'Учебная дорога', 'Условная станция']) {
    expect(text).not.toContain(secret)
  }
})

test('A4 print contains exactly one page', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Открыть файл' }).click()
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

test('distances and speeds follow normative values but stay editable; saved projects are easy to find', async ({
  page,
  request,
}) => {
  await importSampleCards(request)
  await page.goto('/')
  await fillNewProject(page, '36 км 1 пк', '90003:36:1')
  await page.getByRole('button', { name: 'Создать проект' }).click()
  await page.getByRole('button', { name: /Схема движения.*Размеры и вариант/ }).click()

  const d300 = page.locator('[data-field="parameters.signDistancesMetres.d300"]')
  const approach = page.locator('[data-field="parameters.approachSpeedKmh"]')
  await expect(d300).toHaveValue('300')
  await expect(page.locator('[data-field="parameters.speedStagesKmh.0"]')).toHaveValue('70')
  const d300Label = page.locator('label', { has: d300 })
  await expect(d300Label).toContainText('по нормативу')

  // Правка под местные условия остаётся и помечается.
  await d300.fill('280')
  await expect(d300Label).toContainText('Изменено · норматив 300')

  // Смена местоположения подставляет значения населённого пункта, правка вне его сохраняется.
  await page.locator('[data-field="parameters.location"]').selectOption('in')
  await expect(approach).toHaveValue('60')
  await expect(page.locator('[data-field="parameters.signDistancesMetres.n100"]')).toHaveValue(
    '100',
  )
  await expect(d300).toHaveCount(0)
  await page.locator('[data-field="parameters.location"]').selectOption('out')
  await expect(approach).toHaveValue('90')
  await expect(d300).toHaveValue('280')
  await d300Label.getByRole('button', { name: 'Вернуть' }).click()
  await expect(d300).toHaveValue('300')

  // Своя разрешённая скорость пересчитывает ступени: 70 → 50 → 40 на 50 → 40 → 40.
  await approach.fill('70')
  await approach.blur()
  await expect(page.locator('[data-field="parameters.speedStagesKmh.0"]')).toHaveValue('50')
  await expect(page.locator('label', { has: approach })).toContainText('Изменено · норматив 90')
  await page.getByRole('button', { name: 'Вернуть все нормативные значения' }).click()
  await expect(approach).toHaveValue('90')
  await expect(page.locator('[data-field="parameters.speedStagesKmh.0"]')).toHaveValue('70')

  // Отличие от норматива попадает в «Проверить вручную», «Перейти» ведёт к полю на этапе 2.
  await d300.fill('280')
  await page.getByRole('button', { name: 'Применить правки' }).click()
  await page.getByRole('button', { name: /Проверка и лист.*A4 для сверки/ }).click()
  await page
    .locator('li', { hasText: 'Расстояния и скорости не по нормативным значениям' })
    .getByRole('link', { name: 'Перейти' })
    .click()
  await expect(d300).toBeFocused()
  await d300Label.getByRole('button', { name: 'Вернуть' }).click()
  await page.getByRole('button', { name: 'Применить правки' }).click()
  await page.getByRole('button', { name: 'Сохранить проект' }).click()
  await expect(page.locator('.save-state')).toHaveText('Сохранён')

  // «Мои проекты»: проект узнаётся по переезду и находится поиском.
  await page.getByRole('button', { name: 'Мои проекты' }).first().click()
  const list = page.locator('#local-projects-title ~ .project-list')
  const card = list.locator('li', { hasText: 'Переезд 90003:36:1' })
  await expect(card).toContainText('открыт сейчас')
  await page.getByLabel('Найти проект').fill('90003')
  await expect(list.locator('> li')).toHaveCount(1)
  await page.getByLabel('Найти проект').fill('нет такого переезда')
  await expect(page.getByText('Ничего не найдено')).toBeVisible()
})

test('template plate 8.2.1 shows the dangerous section length and the sign size follows table 1', async ({
  page,
  request,
}) => {
  await importSampleCards(request)
  await page.goto('/')
  await fillNewProject(page, '12 км 3 пк', '90001:12:3')
  await page.getByRole('button', { name: 'Создать проект' }).click()
  await page.getByRole('button', { name: /Схема движения.*Размеры и вариант/ }).click()
  // Двухполосная дорога вне населённого пункта: типоразмер II по таблице 1 ГОСТ Р 52289.
  const size = page.locator('[data-field="parameters.signSize"]')
  await expect(size).toHaveValue('II')
  await expect(page.locator('label', { has: size })).toContainText('по нормативу')
  await size.selectOption('III')
  await expect(page.locator('label', { has: size })).toContainText('Изменено · норматив II')
  await page.getByLabel('Регулирование Б.34').selectOption('two')
  await page.getByLabel('Интенсивность, авт./ч (по данным составителя)').fill('300')
  await page.getByRole('button', { name: 'Применить правки' }).click()
  await page.getByRole('button', { name: /Проверка и лист.*A4 для сверки/ }).click()
  await expect(page.locator('li', { hasText: 'Типоразмер знаков не по таблице 1' })).toBeVisible()

  await page.getByRole('button', { name: /Знаки и объекты.*Поле и свойства/ }).click()
  await page.getByRole('button', { name: 'Собрать черновой шаблон' }).click()
  // Отвод 10 + буфер 10 + фронт 18 = 38 м от начала отвода до конца работ.
  const plates = page.locator('.print-host [data-drawn-sign="8.2.1_38"]')
  await expect(plates).toHaveCount(2)
  await expect(plates.first()).toContainText('38 м')
})

test('help shows the author, the MIT license and third-party components', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Справка', exact: true }).first().click()
  await page
    .getByRole('navigation', { name: 'Оглавление справки' })
    .getByRole('button', { name: 'О программе и лицензии' })
    .click()
  const about = page.locator('[data-help="about"]')
  await expect(about).toContainText('Манченко Иван Григорьевич')
  await about.getByText('Текст лицензии (оригинал, имеет юридическую силу)').click()
  await expect(about.locator('pre[lang="en"]')).toContainText('Permission is hereby granted')
  // В сборке (exe) — список компонентов; в режиме разработки он не формируется.
  await expect(
    about.getByText(/Открыть полные тексты лицензий|Список формируется при сборке/),
  ).toBeVisible()
  if (process.env.TOD_E2E_EXE) {
    await about.getByText(/Локальный сервер —/).click()
    await expect(about.getByRole('cell', { name: 'pdfjs-dist' })).toBeVisible()
  }
})

test('revision save locks input, restore creates history and a conflict preserves undo', async ({
  page,
  request,
}) => {
  const scheme = importSchemeJson(readFileSync('tests/fixtures/manual-v1.json', 'utf8')).scheme
  scheme.parameters.location = 'out'
  const id = scheme.id
  await page.goto('/')
  await page.getByRole('button', { name: 'Открыть файл', exact: true }).click()
  await page.locator('#scheme-file').setInputFiles({
    name: `revisions-${id}.json`,
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(scheme)),
  })
  await page.getByRole('button', { name: 'Сохранить проект', exact: true }).click()
  await expect(page.locator('.save-state')).toHaveText('Сохранён')
  await page.getByRole('button', { name: 'Сохранить проект', exact: true }).click()
  await expect(page.locator('.feedback.notice')).toContainText('версия 1')
  await expect(page.locator('.feedback.error')).toHaveCount(0)
  expect((await (await request.get(`${api}/api/projects/${id}`)).json()).revision).toBe(1)
  await page.getByRole('button', { name: /Схема движения.*Размеры и вариант/ }).click()
  const field = page.locator('[data-field="parameters.signDistancesMetres.d300"]')
  await field.fill('280')
  await page.getByRole('button', { name: 'Применить правки' }).click()

  let release!: () => void
  const delivery = new Promise<void>((resolve) => {
    release = resolve
  })
  let written = false
  await page.route(`**/api/projects/${id}`, async (route) => {
    if (route.request().method() !== 'PUT') return route.continue()
    const response = await route.fetch()
    written = true
    await delivery
    await route.fulfill({ response })
  })
  await page.getByRole('button', { name: 'Сохранить проект', exact: true }).click()
  await expect.poll(() => written).toBe(true)
  await expect(field).toBeDisabled()
  release()
  await expect(page.locator('.save-state')).toHaveText('Сохранён')
  await page.unroute(`**/api/projects/${id}`)
  await expect(field).toHaveValue('280')
  await page.getByText('Действия с проектом', { exact: true }).click()
  await expect(page.getByRole('button', { name: 'Отменить действие', exact: true })).toBeEnabled()

  await page.getByRole('button', { name: 'Мои проекты', exact: true }).first().click()
  const activeCard = page
    .locator('#local-projects-title ~ .project-list > li')
    .filter({ hasText: 'открыт сейчас' })
  await expect(activeCard).toHaveCount(1)
  await activeCard.getByRole('button', { name: 'Версии', exact: true }).click()
  page.once('dialog', (dialog) => dialog.accept())
  await activeCard.getByRole('button', { name: 'Вернуться к этой версии', exact: true }).click()
  await expect(page.locator('.feedback.notice')).toContainText('сохранён как версия 3')
  const restored = await (await request.get(`${api}/api/projects/${id}`)).json()
  expect(restored.revision).toBe(3)
  expect(restored.scheme.parameters.signDistancesMetres.d300).toBe(
    scheme.parameters.signDistancesMetres.d300,
  )
  const revisions = await (await request.get(`${api}/api/projects/${id}/revisions`)).json()
  expect(revisions.map((item: { revision: number }) => item.revision)).toEqual([3, 2, 1])

  await page.getByRole('button', { name: /Схема движения.*Размеры и вариант/ }).click()
  await expect(field).toHaveValue(String(scheme.parameters.signDistancesMetres.d300))
  await expect(page.getByRole('button', { name: 'Отменить действие', exact: true })).toBeDisabled()
  await field.fill('270')
  await page.getByRole('button', { name: 'Применить правки' }).click()
  // Another local client advances the database while this editor keeps revision 3.
  const concurrent = await request.put(`${api}/api/projects/${id}`, {
    headers: { Origin: origin },
    data: {
      scheme: {
        ...restored.scheme,
        parameters: { ...restored.scheme.parameters, locationText: 'Правка другого окна' },
      },
      expectedRevision: 3,
    },
  })
  expect(concurrent.ok()).toBe(true)
  expect((await concurrent.json()).revision).toBe(4)
  await page.getByRole('button', { name: 'Сохранить проект', exact: true }).click()
  await expect(page.locator('.feedback.error')).toContainText('Ваши правки остались открытыми')
  await expect(field).toHaveValue('270')
  await expect(page.getByRole('button', { name: 'Отменить действие', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: 'Отменить действие', exact: true }).click()
  await expect(field).toHaveValue(String(scheme.parameters.signDistancesMetres.d300))
  await expect(page.getByRole('button', { name: 'Повторить действие', exact: true })).toBeEnabled()
  expect((await (await request.get(`${api}/api/projects/${id}`)).json()).revision).toBe(4)
})

test('editor shell keeps one recovery session, form input and history across screens', async ({
  page,
  request,
}) => {
  const scheme = importSchemeJson(readFileSync('tests/fixtures/manual-v1.json', 'utf8')).scheme
  scheme.parameters.location = 'out'
  const filename = `shell-details-${scheme.id}.json`
  let ownerId = ''
  page.on('request', (call) => {
    if (call.method() === 'PUT' && call.url().includes('/api/recovery/')) {
      const body = call.postDataJSON()
      if (body.fileName === filename) ownerId = body.ownerId
    }
  })
  await page.goto('/')
  await page.getByRole('button', { name: 'Открыть файл', exact: true }).click()
  await page.locator('#scheme-file').setInputFiles({
    name: filename,
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(scheme)),
  })
  await page.getByRole('button', { name: /Схема движения.*Размеры и вариант/ }).click()
  const d300 = page.locator('[data-field="parameters.signDistancesMetres.d300"]')
  await d300.fill('280')
  await expect(page.locator('.save-state')).toContainText(
    'Неприменённый ввод · копия восстановления записана',
  )
  const copies = (await (await request.get(`${api}/api/recovery`)).json()).filter(
    (copy: { fileName: string }) => copy.fileName === filename,
  )
  expect(copies).toHaveLength(1)
  const sessionId = copies[0].sessionId
  for (const name of [
    /Исходные данные.*Переезд и ПУ-66/,
    /Знаки и объекты.*Поле и свойства/,
    /^Проекты$/,
    /^Справка$/,
    /^Реестры$/,
  ]) {
    await page.getByRole('button', { name }).first().click()
  }
  await page.getByRole('button', { name: /Схема движения.*Размеры и вариант/ }).click()
  await expect(d300).toHaveValue('280')
  await page.getByRole('button', { name: 'Применить правки' }).click()
  const d250 = page.locator('[data-field="parameters.signDistancesMetres.d250"]')
  await d250.fill('260')
  await page.getByRole('button', { name: 'Справка', exact: true }).first().click()
  await page.getByRole('button', { name: /Схема движения.*Размеры и вариант/ }).click()
  await expect(d250).toHaveValue('260')
  await page.getByRole('button', { name: 'Применить правки' }).click()
  await page.getByText('Действия с проектом', { exact: true }).click()
  await page.getByRole('button', { name: 'Отменить действие', exact: true }).click()
  await expect(d300).toHaveValue('280')
  await expect(d250).toHaveValue(String(scheme.parameters.signDistancesMetres.d250))
  await page.getByRole('button', { name: 'Повторить действие', exact: true }).click()
  await expect(d250).toHaveValue('260')
  await expect(page.locator('.save-state')).toContainText('Копия восстановления записана')
  const after = (await (await request.get(`${api}/api/recovery`)).json()).filter(
    (copy: { fileName: string }) => copy.fileName === filename,
  )
  expect(after.map((copy: { sessionId: string }) => copy.sessionId)).toEqual([sessionId])
  const snapshot = await (
    await request.get(`${api}/api/recovery/${sessionId}?ownerId=${ownerId}`)
  ).json()
  expect(snapshot.scheme.id).toBe(scheme.id)
  expect(snapshot.scheme.parameters.signDistancesMetres).toMatchObject({ d300: 280, d250: 260 })
})

test('editor shell keeps a selected object and unapplied object input across screens', async ({
  page,
  request,
}) => {
  const scheme = importSchemeJson(readFileSync('tests/fixtures/manual-v1.json', 'utf8')).scheme
  const filename = `shell-object-${scheme.id}.json`
  await page.goto('/')
  await page.getByRole('button', { name: 'Открыть файл', exact: true }).click()
  await page.locator('#scheme-file').setInputFiles({
    name: filename,
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(scheme)),
  })
  await page.getByRole('button', { name: /Знаки и объекты.*Поле и свойства/ }).click()
  const selected = page
    .getByRole('navigation', { name: 'Объекты открытого проекта' })
    .getByRole('button', { name: /^№ 2/ })
  await selected.click()
  const text = page.getByLabel('Текст надписи', { exact: true })
  await text.fill('Неприменённая правка объекта')
  await expect(page.locator('.save-state')).toContainText(
    'Неприменённый ввод · копия восстановления записана',
  )
  for (const name of [/Схема движения.*Размеры и вариант/, /^Проекты$/, /^Реестры$/, /^Справка$/]) {
    await page.getByRole('button', { name }).first().click()
  }
  await page.getByRole('button', { name: /Знаки и объекты.*Поле и свойства/ }).click()
  await expect(selected).toHaveAttribute('aria-pressed', 'true')
  await expect(text).toHaveValue('Неприменённая правка объекта')
  await expect(page.getByRole('button', { name: 'Сохранить проект', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: 'Применить объект', exact: true }).click()
  await page.getByText('Действия с проектом', { exact: true }).click()
  await page.getByRole('button', { name: 'Отменить действие', exact: true }).click()
  await expect(text).toHaveValue('Ручная правка')
  await page.getByRole('button', { name: 'Повторить действие', exact: true }).click()
  await expect(text).toHaveValue('Неприменённая правка объекта')
  await expect(page.locator('.save-state')).toContainText('Копия восстановления записана')
  const copies = (await (await request.get(`${api}/api/recovery`)).json()).filter(
    (copy: { fileName: string }) => copy.fileName === filename,
  )
  expect(copies).toHaveLength(1)
})
