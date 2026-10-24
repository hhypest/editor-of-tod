import { expect, test, type Page } from '@playwright/test'
import {
  parameterDefinitions,
  type ParameterDefinition,
  type ParameterState,
} from '../../src/domain/normative-parameters'
import type { DocumentRecord } from '../../src/domain/normative-documents'
import { fictionalSignStandard } from '../../server/__tests__/pdf-fixture'
import { createSampleWorkbook, sampleCards } from '../../scripts/generate-pu66-samples'

function parameterState(
  definition: ParameterDefinition,
  index: number,
  confirmed: boolean,
): ParameterState {
  const source = definition.source
  const documentId = source.kind === 'decision' ? null : 1
  const value = definition.fallback ?? (definition.type === 'number' ? 1 : { Условие: '1' })
  return {
    id: definition.id,
    status: { kind: confirmed ? 'confirmed' : 'unconfirmed' },
    document: null,
    quote: null,
    suggestion: null,
    confirmation: confirmed
      ? {
          id: index + 1,
          parameterId: definition.id,
          documentId,
          documentLabel: source.kind === 'decision' ? 'Решение составителя' : source.documentCode,
          clause:
            source.kind === 'decision'
              ? ''
              : source.kind === 'table'
                ? source.clause
                : `п. ${source.clause}`,
          page: source.kind === 'decision' ? null : 1,
          quote: 'Учебная цитата',
          fragment: 'Учебная цитата',
          value,
          confirmedBy: 'Автоматическая проверка',
          confirmedAt: '2026-10-23T00:00:00.000Z',
          note: '',
        }
      : null,
    amendments: [],
  }
}

function sourceDocuments(): DocumentRecord[] {
  const codes = [
    ...new Set([
      'ГОСТ Р 52290',
      ...parameterDefinitions.flatMap((d) =>
        d.source.kind === 'decision' ? [] : [d.source.documentCode],
      ),
    ]),
  ]
  return codes.map((code, index) => ({
    id: index + 100,
    code,
    edition: 'Учебная версия',
    title: 'Вымышленный документ',
    kind: code.includes('52290') ? 'signs' : code.startsWith('ОДМ') ? 'methodology' : 'rules',
    effectiveFrom: '2020-01-01',
    amendsId: null,
    note: '',
    actualCheckedAt: '2026-10-24',
    filename: 'fictional.pdf',
    sha256: 'a'.repeat(64),
    sizeBytes: 100,
    addedAt: '2026-10-24T00:00:00.000Z',
  }))
}
async function initialRoutes(
  page: Page,
  documents: () => DocumentRecord[],
  confirmed: () => boolean,
) {
  await page.route('**/api/projects', (route) => route.fulfill({ json: [] }))
  await page.route('**/api/documents', (route) =>
    route.request().method() === 'GET' ? route.fulfill({ json: documents() }) : route.continue(),
  )
  await page.route('**/api/normative-parameters', (route) =>
    route.fulfill({ json: parameterDefinitions.map((d, i) => parameterState(d, i, confirmed())) }),
  )
}

test('clean start performs document, extraction and card intake inside the setup screen', async ({
  page,
}) => {
  const library: DocumentRecord[] = []
  let signs: unknown[] = []
  let cards: unknown[] = []
  await initialRoutes(
    page,
    () => library,
    () => false,
  )
  await page.route('**/api/signs', (route) => route.fulfill({ json: signs }))
  await page.route('**/api/pu66', (route) => route.fulfill({ json: cards }))
  await page.route('**/api/documents/apply', async (route) => {
    const response = await route.fetch()
    const body = await response.json()
    if (response.ok()) library.push(body.document)
    await route.fulfill({ response })
  })
  await page.route('**/api/documents/*/signs/apply', async (route) => {
    const response = await route.fetch()
    if (response.ok()) signs = [{ code: '1.8' }]
    await route.fulfill({ response })
  })
  await page.route('**/api/pu66/import/apply', async (route) => {
    const response = await route.fetch()
    if (response.ok()) cards = [{ referenceId: 'TEST-SETUP' }]
    await route.fulfill({ response })
  })
  await page.goto('/')
  const setup = page.getByTestId('setup-workspace')
  await expect(setup.getByRole('heading', { name: '1. Дорожные знаки', exact: true })).toBeVisible()
  await expect(page.getByRole('complementary', { name: 'Этапы работы' })).not.toBeVisible()
  await expect(page.getByRole('complementary', { name: 'Предпросмотр схемы' })).not.toBeVisible()
  await expect(page.getByRole('group', { name: 'Способ открытия проекта' })).not.toBeVisible()
  await expect(setup.getByRole('button', { name: 'Далее', exact: true })).toBeDisabled()
  await expect(setup.getByLabel('Обозначение', { exact: true })).not.toBeVisible()
  const source = setup.getByRole('region', { name: 'Подготовка знаков' })
  const pdf = Buffer.concat([fictionalSignStandard(), Buffer.from(`\n% setup ${Date.now()}`)])
  const choosing = page.waitForEvent('filechooser')
  await source.getByRole('button', { name: 'Выбрать файл', exact: true }).click()
  await (
    await choosing
  ).setFiles({ name: 'GOST-R-52290-2026.pdf', mimeType: 'application/pdf', buffer: pdf })
  await source.getByRole('button', { name: 'Использовать сведения из имени файла' }).click()
  await source.getByLabel(/^Назначение/).selectOption('signs')
  await source.getByLabel('Дата введения в действие').fill('2020-01-01')
  await source.getByRole('button', { name: 'Проверить документ', exact: true }).click()
  await source.getByRole('button', { name: /Добавить в библиотеку/ }).click()
  await source.getByRole('button', { name: 'Извлечь знаки из ГОСТ', exact: true }).click()
  const missing = source.locator('[data-key="2-5"]')
  await missing.getByLabel('Номер', { exact: true }).fill('1.33')
  await missing.getByLabel('Номер', { exact: true }).blur()
  await source.getByRole('button', { name: 'Проверить снова', exact: true }).click()
  await source.getByRole('button', { name: /Записать каталог знаков/ }).click()
  await expect(setup.getByRole('button', { name: 'Далее', exact: true })).toBeEnabled()
  await setup.getByRole('button', { name: 'Далее', exact: true }).click()
  await expect(setup.getByRole('heading', { name: '2. Карточки переездов' })).toBeVisible()
  await expect(
    setup.getByRole('heading', { name: 'Локальная сверка импортированных карточек' }),
  ).not.toBeVisible()
  const intake = setup.getByRole('region', { name: 'Подготовка карточек' })
  const card = sampleCards[0]!
  const book = await createSampleWorkbook({ ...card, length: 41.25 })
  await intake.getByLabel('Книги ПУ-66', { exact: true }).setInputFiles({
    name: card.filename,
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: book,
  })
  await setup.getByRole('button', { name: 'Назад', exact: true }).click()
  await setup.getByRole('button', { name: 'Далее', exact: true }).click()
  expect(
    await intake
      .locator('input[type="file"]')
      .evaluate((input: HTMLInputElement) => input.files?.length),
  ).toBe(1)
  await intake.getByRole('button', { name: 'Просмотреть изменения', exact: true }).click()
  await intake.getByRole('button', { name: /Подтвердить импорт и создать/ }).click()
  await expect(setup.getByRole('button', { name: 'Далее', exact: true })).toBeEnabled()
  await setup.getByRole('button', { name: 'Далее', exact: true }).click()
  await expect(setup.getByRole('heading', { name: '3. Документы для правил' })).toBeVisible()
  await expect(setup.getByRole('button', { name: 'Далее', exact: true })).toBeDisabled()
  await setup.getByRole('button', { name: 'Нужна подсказка' }).click()
  await expect(setup).toContainText('«Назад» сохраняет ввод')
})

test('parameter review is focused, errors block completion and retry restores it', async ({
  page,
}) => {
  let confirmed = false
  let fail = false
  const ownConfirmed = new Set<string>()
  const documents = sourceDocuments()
  await initialRoutes(
    page,
    () => documents,
    () => confirmed,
  )
  await page.route('**/api/signs', (route) => route.fulfill({ json: [{ code: '1.25' }] }))
  await page.route('**/api/pu66', (route) => route.fulfill({ json: [{ referenceId: 'TEST-001' }] }))
  await page.route('**/api/normative-parameters', (route) =>
    fail
      ? route.fulfill({ contentType: 'text/html', body: '<!doctype html>' })
      : route.fulfill({
          json: parameterDefinitions.map((d, i) =>
            parameterState(d, i, confirmed || ownConfirmed.has(d.id)),
          ),
        }),
  )
  await page.route('**/api/normative-parameters/*/confirm', async (route) => {
    const response = await route.fetch()
    if (response.ok())
      ownConfirmed.add(
        decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-2)!),
      )
    await route.fulfill({ response })
  })
  await page.goto('/')
  const setup = page.getByTestId('setup-workspace')
  await expect(setup.getByRole('heading', { name: '4. Подтверждение параметров' })).toBeVisible()
  const review = setup.getByRole('region', { name: 'Подготовка параметров' })
  await expect(review.locator('[data-parameter]')).toHaveCount(1)
  await expect(setup.getByRole('button', { name: 'Завершить настройку' })).toBeDisabled()
  await review.getByLabel('Кто подтверждает (для журнала)').fill('Учебный составитель')
  await setup.getByRole('button', { name: 'Назад', exact: true }).click()
  await setup.getByRole('button', { name: 'Далее', exact: true }).click()
  await expect(review.getByLabel('Кто подтверждает (для журнала)')).toHaveValue(
    'Учебный составитель',
  )
  const decisionIndex = parameterDefinitions.findIndex(
    (d) => d.source.kind === 'decision' && d.type === 'number',
  )
  const decision = parameterDefinitions[decisionIndex]!
  await review.locator('.parameter-navigation select').selectOption(String(decisionIndex))
  await review.locator('.confirm input[inputmode="decimal"]').fill(String(decision.fallback))
  await review
    .getByLabel(/^Основание решения/)
    .fill('Учебное решение для проверки мастера, не нормативное значение.')
  await review.getByRole('button', { name: 'Подтвердить значение', exact: true }).click()
  await expect.poll(() => ownConfirmed.size).toBe(1)
  await expect(review.locator('[data-parameter]')).not.toHaveAttribute(
    'data-parameter',
    decision.id,
  )
  confirmed = true
  fail = true
  await review.getByRole('button', { name: 'Обновить', exact: true }).click()
  await expect(review.getByRole('alert')).toBeVisible()
  await expect(setup.getByRole('button', { name: 'Завершить настройку' })).toBeDisabled()
  fail = false
  await review.getByRole('button', { name: 'Повторить загрузку параметров', exact: true }).click()
  await expect(setup.getByRole('button', { name: 'Завершить настройку' })).toBeEnabled()
  await setup.getByRole('button', { name: 'Завершить настройку' }).click()
  await expect(setup).not.toBeVisible()
  await expect(page.getByTestId('first-run-wizard')).toContainText('Настройка завершена')
})

test('setup can be deferred without blocking existing projects and opened again', async ({
  page,
}) => {
  await initialRoutes(
    page,
    () => [],
    () => false,
  )
  await page.route('**/api/signs', (route) => route.fulfill({ json: [] }))
  await page.route('**/api/pu66', (route) => route.fulfill({ json: [] }))
  await page.goto('/')
  const setup = page.getByTestId('setup-workspace')
  await setup.getByRole('button', { name: 'Продолжить позже' }).click()
  await expect(page.getByRole('group', { name: 'Способ открытия проекта' })).toBeVisible()
  await page.reload()
  await expect(setup).not.toBeVisible()
  await page.getByRole('button', { name: 'Продолжить настройку', exact: true }).click()
  await expect(setup).toBeVisible()
  await expect(setup.getByRole('button', { name: 'Назад', exact: true })).toBeDisabled()
})
