import { expect, test, type Page } from '@playwright/test'
import { textPdf } from '../../server/__tests__/pdf-fixture'
import type { ParameterState } from '../../src/domain/normative-parameters'

async function openDocuments(page: Page) {
  await page.goto('/')
  await page.getByRole('button', { name: 'Реестры', exact: true }).click()
  await page.getByRole('button', { name: 'Нормативные документы', exact: true }).click()
  return page.locator('.library')
}

test('PDD identification separates the resolution date from edition and effective date', async ({
  page,
}) => {
  const library = await openDocuments(page)
  await library.locator('input[type="file"]').setInputFiles({
    name: 'synthetic.pdf',
    mimeType: 'application/pdf',
    buffer: textPdf([
      [
        'Постановление Правительства РФ от 23.10.1993 N 1090',
        '(ред. от 28.08.2026)',
        'О Правилах дорожного движения',
        'Вымышленный учебный фрагмент.',
      ],
    ]),
  })
  await expect(library.locator('.candidate')).toContainText('2026-08-28')
  await library.getByRole('button', { name: 'Использовать сведения', exact: true }).click()
  await expect(library.getByLabel('Обозначение', { exact: true })).toHaveValue('ПДД')
  await expect(library.getByLabel('Редакция', { exact: true })).toHaveValue('2026-08-28')
  await expect(library.getByLabel('Дата введения в действие', { exact: true })).toHaveValue('')
  await expect(library).toContainText('не подтверждают вступление изменений в силу')
})

for (const variant of [
  {
    name: 'obsolete document',
    documentLabel: 'ОДМ 218.6.019-2016',
    clause: 'таблица И.1, примечание 3',
    suggestion: null,
    expected: '15',
  },
  {
    name: 'obsolete clause',
    documentLabel: 'ГОСТ Р 58350-2019',
    clause: 'п. 4.1.8.3',
    suggestion: null,
    expected: '15',
  },
  {
    name: 'current confirmation',
    documentLabel: 'ГОСТ Р 58350-2019',
    clause: 'таблица И.1, примечание 3',
    suggestion: null,
    expected: '99',
  },
  {
    name: 'new document suggestion',
    documentLabel: 'ОДМ 218.6.019-2016',
    clause: 'п. 4.1.8.3',
    suggestion: 17,
    expected: '17',
  },
]) {
  test(`the confirmation form uses ${variant.name} safely`, async ({ page }) => {
    const state: ParameterState = {
      id: 'odm-signs-taper',
      status: { kind: 'changed', previous: variant.documentLabel },
      document: { id: 2, label: 'ГОСТ Р 58350-2019', sha256: 'synthetic' },
      quote: null,
      suggestion: variant.suggestion,
      amendments: [],
      confirmation: {
        id: 1,
        parameterId: 'odm-signs-taper',
        documentId: 1,
        documentLabel: variant.documentLabel,
        clause: variant.clause,
        page: null,
        quote: '',
        fragment: '',
        value: 99,
        confirmedBy: 'Учебный составитель',
        confirmedAt: '2026-01-01',
        note: 'Учебное основание',
      },
    }
    await page.route('**/api/normative-parameters', (route) => route.fulfill({ json: [state] }))
    await page.goto('/')
    await page.getByRole('button', { name: 'Реестры', exact: true }).click()
    await page.getByRole('button', { name: 'Нормативные параметры', exact: true }).click()
    const item = page.locator('[data-parameter="odm-signs-taper"]')
    await expect(item.locator('.status').first()).toContainText(variant.documentLabel)
    await item.getByRole('button', { name: 'Проверить и подтвердить' }).click()
    await expect(item.getByLabel('Значение, м', { exact: true })).toHaveValue(variant.expected)
  })
}

test('PDF title wins over filename; manual edits survive file changes and previews expire', async ({
  page,
}) => {
  const library = await openDocuments(page)
  const input = library.locator('input[type="file"]')
  const pdf = (code: string) => textPdf([[code, 'Вымышленный стандарт']])
  await input.setInputFiles({
    name: 'ГОСТ Р 90002-2021.pdf',
    mimeType: 'application/pdf',
    buffer: pdf('ГОСТ Р 90001-2020'),
  })
  await expect(library).toContainText('не совпадает с текстом PDF')
  await expect(
    library.getByRole('button', { name: 'Проверить документ', exact: true }),
  ).toBeDisabled()
  await library.getByRole('button', { name: 'Использовать сведения', exact: true }).click()
  await expect(library.getByLabel('Обозначение', { exact: true })).toHaveValue('ГОСТ Р 90001')
  await expect(library.getByLabel('Редакция', { exact: true })).toHaveValue('2020')
  await library.getByLabel('Название', { exact: true }).fill('Название, уточнённое вручную')
  await library.getByRole('button', { name: 'Проверить документ', exact: true }).click()
  await expect(library.getByRole('button', { name: /Добавить в библиотеку/ })).toBeVisible()
  await library.getByLabel('Примечание', { exact: true }).fill('Ручная проверка')
  await expect(library.getByRole('button', { name: /Добавить в библиотеку/ })).toHaveCount(0)
  await input.setInputFiles({
    name: 'next.pdf',
    mimeType: 'application/pdf',
    buffer: pdf('ГОСТ Р 90003-2022'),
  })
  await expect(library.locator('.candidate')).toContainText('ГОСТ Р 90003')
  await expect(library.getByLabel('Обозначение', { exact: true })).toHaveValue('')
  await expect(library.getByLabel('Редакция', { exact: true })).toHaveValue('')
  await expect(library.getByLabel('Название', { exact: true })).toHaveValue(
    'Название, уточнённое вручную',
  )
  await library.getByRole('button', { name: 'Заполнить вручную', exact: true }).click()
  await library.getByLabel('Обозначение', { exact: true }).fill('ГОСТ Р 90003')
  await library.getByLabel('Редакция', { exact: true }).fill('2022')
  await library.getByRole('button', { name: 'Проверить документ', exact: true }).click()
  await expect(library.getByRole('button', { name: /Добавить в библиотеку/ })).toBeVisible()
})

test('a late identification response cannot replace the next file proposal', async ({ page }) => {
  let releaseFirst!: () => void
  let firstStarted!: () => void
  const gate = new Promise<void>((resolve) => {
    releaseFirst = resolve
  })
  const started = new Promise<void>((resolve) => {
    firstStarted = resolve
  })
  await page.route('**/api/documents/identify', async (route) => {
    if (route.request().postDataJSON().file.name === 'old.pdf') {
      firstStarted()
      await gate
    }
    await route.continue()
  })
  const library = await openDocuments(page)
  const input = library.locator('input[type="file"]')
  await input.setInputFiles({
    name: 'old.pdf',
    mimeType: 'application/pdf',
    buffer: textPdf([['ОДМ 900.1.001-2020']]),
  })
  await started
  await input.setInputFiles({
    name: 'new.pdf',
    mimeType: 'application/pdf',
    buffer: textPdf([['ОДМ 900.1.002-2021']]),
  })
  await expect(library.locator('.candidate')).toContainText('ОДМ 900.1.002')
  const late = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/documents/identify') &&
      response.request().postDataJSON().file.name === 'old.pdf',
  )
  releaseFirst()
  await late
  await library.getByRole('button', { name: 'Использовать сведения', exact: true }).click()
  await expect(library.getByLabel('Обозначение', { exact: true })).toHaveValue('ОДМ 900.1.002')
})

test('a missing quote requires grounds before posting and a server rejection preserves the form', async ({
  page,
  request,
}) => {
  const headers = { Origin: 'http://127.0.0.1:5173' }
  const body = {
    file: {
      name: 'synthetic.pdf',
      data: textPdf([['Учебный документ без нужного пункта']]).toString('base64'),
    },
    meta: {
      code: 'ОДМ 218.6.019',
      edition: 'Учебная проверка отсутствующей цитаты',
      title: 'Учебная методика',
      kind: 'methodology',
      effectiveFrom: new Date().toISOString().slice(0, 10),
      amendsId: null,
      note: '',
      actualCheckedAt: '',
    },
  }
  const preview = await request.post('http://127.0.0.1:4100/api/documents/preview', {
    headers,
    data: body,
  })
  const plan = await preview.json()
  expect(
    (
      await request.post('http://127.0.0.1:4100/api/documents/apply', {
        headers,
        data: { ...body, expectedFingerprint: plan.fingerprint },
      })
    ).ok(),
  ).toBe(true)
  await page.goto('/')
  await page.getByRole('button', { name: 'Реестры', exact: true }).click()
  await page.getByRole('button', { name: 'Нормативные параметры', exact: true }).click()
  const box = page.locator('.parameters')
  const item = box.locator('[data-parameter="odm-signs-hourly"]')
  await box.getByLabel('Кто подтверждает (для журнала)').fill('Учебный составитель')
  await item.getByRole('button', { name: 'Проверить и подтвердить' }).click()
  const note = item.getByLabel('Примечание: страница и формулировка (обязательно)')
  let posted = 0
  await page.route('**/api/normative-parameters/odm-signs-hourly/confirm', async (route) => {
    posted++
    await route.fulfill({
      status: 400,
      json: {
        error: 'Допустимо другое учебное значение.',
        reason: 'invalid-value',
        field: 'value',
      },
    })
  })
  await item.getByLabel('Значение, авт/ч').fill('260')
  await item.getByRole('button', { name: 'Подтвердить значение' }).click()
  await expect(note).toHaveAttribute('aria-invalid', 'true')
  expect(posted).toBe(0)
  await note.fill('Учебная страница и проверенная формулировка')
  await item.getByRole('button', { name: 'Подтвердить значение' }).click()
  await expect(item.getByRole('alert')).toContainText('другое учебное значение')
  await expect(item.getByLabel('Значение, авт/ч')).toHaveValue('260')
  await expect(item.getByLabel('Значение, авт/ч')).toHaveAttribute('aria-invalid', 'true')
  await expect(note).toHaveValue('Учебная страница и проверенная формулировка')
  expect(posted).toBe(1)
})
