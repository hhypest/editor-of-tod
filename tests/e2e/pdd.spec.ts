import { readFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'
import {
  parameterDefinition,
  PDD_OUTSIDE_SPEED_KEYS,
  type ParameterState,
} from '../../src/domain/normative-parameters'

test('the light-vehicle reference applies the scalar limit despite a conflicting confirmed table', async ({
  page,
}) => {
  const table = parameterDefinition('pdd-speed-outside-conditions')!
  if (table.type !== 'table') throw new Error('Expected table')
  const state = (id: string, value: number | Record<string, string>): ParameterState => ({
    id,
    status: { kind: 'confirmed' },
    document: { id: 1, label: 'ПДД-2030-04-01', sha256: 'a'.repeat(64) },
    quote: null,
    suggestion: null,
    amendments: [],
    confirmation: {
      id: 1,
      parameterId: id,
      documentId: 1,
      documentLabel: 'ПДД-2030-04-01',
      clause: 'п. 10.3',
      page: 1,
      quote: '',
      fragment: '',
      value,
      confirmedBy: 'Учебный составитель',
      confirmedAt: '2030-05-01',
      note: 'Учебная сверка',
    },
  })
  await page.route('**/api/normative-parameters', (route) =>
    route.fulfill({
      json: [
        state('pdd-speed-outside', 87),
        state(table.id, { ...table.fallback, [PDD_OUTSIDE_SPEED_KEYS.lightOrdinary]: '92' }),
      ],
    }),
  )
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
  await reference.getByLabel('Вид дороги для сверки скорости').selectOption('ordinary')
  await reference.getByLabel('Вид ТС для сверки скорости').selectOption('light')
  await expect(reference.getByRole('status')).toContainText('87 км/ч')
  await expect(reference.getByRole('status')).toContainText('Числа подтверждены по библиотеке.')
  await reference.getByRole('button', { name: 'Подставить скорость для выбранных условий' }).click()
  await expect(page.locator('[data-field="parameters.approachSpeedKmh"]:visible')).toHaveValue('87')
})

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

test('decision evidence and speed conditions survive SQLite and JSON; changed sources remain historical and require a new record', async ({
  page,
  request,
}) => {
  const { importSchemeJson } = await import('../../src/domain/import')
  const { parameterDefinitions } = await import('../../src/domain/normative-parameters')
  let changed = false
  await page.route('**/api/normative-parameters', (route) => {
    const states: ParameterState[] = parameterDefinitions
      .filter((d) => d.source.kind !== 'decision')
      .map((definition, index) => {
        const source = definition.source
        if (source.kind === 'decision' || definition.fallback === null)
          throw new Error('Expected normative source and value')
        const document = {
          id: index + 1,
          label: `${source.documentCode}-2030`,
          sha256: (changed && source.documentCode === 'ПДД' ? 'b' : 'a').repeat(64),
          effectiveFrom: '2030-01-01',
        }
        return {
          id: definition.id,
          status: { kind: 'confirmed' },
          document,
          confirmationDocument: document,
          amendmentDocuments: [],
          quote: null,
          suggestion: null,
          amendments: [],
          confirmation: {
            id: index + 1,
            parameterId: definition.id,
            documentId: document.id,
            documentLabel: document.label,
            clause: source.kind === 'table' ? source.clause : `п. ${source.clause}`,
            page: 1,
            quote: '',
            fragment: '',
            value: definition.fallback,
            confirmedBy: 'Учебный составитель',
            confirmedAt: '2030-05-01',
            note: '',
          },
        }
      })
    return route.fulfill({ json: states })
  })
  const scheme = importSchemeJson(
    readFileSync('tests/fixtures/legacy-b34-manual.json', 'utf8'),
  ).scheme
  scheme.parameters.location = 'out'
  const file = {
    name: 'synthetic-v9.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(scheme)),
  }
  await page.goto('/')
  await page
    .getByRole('group', { name: 'Способ открытия проекта' })
    .getByRole('button', { name: 'Открыть файл' })
    .click()
  await page.locator('#scheme-file').setInputFiles(file)
  await page.getByRole('button', { name: /Схема движения.*Размеры и вариант/ }).click()
  await page.getByText('Справочник скорости по ПДД', { exact: true }).click()
  const reference = page.locator('.speed-reference')
  await reference.getByLabel('Вид дороги для сверки скорости').selectOption('ordinary')
  await reference.getByLabel('Вид ТС для сверки скорости').selectOption('heavy')
  await reference.getByRole('button', { name: 'Подставить скорость для выбранных условий' }).click()
  await page.getByText('Обоснование решений и источники', { exact: true }).click()
  await page
    .getByLabel('Обоснование скорости', { exact: true })
    .fill('Учебная сверка состава потока и существующих знаков')
  await page.getByRole('button', { name: 'Записать основания скорости', exact: true }).click()
  await page.getByRole('combobox', { name: 'Регулирование Б.34', exact: true }).selectOption('two')
  await page
    .getByLabel('Обоснование регулирования', { exact: true })
    .fill('Учебный выбор двух регулировщиков для согласованного пропуска')
  await page.getByRole('button', { name: 'Записать основания регулирования', exact: true }).click()
  await page.getByRole('button', { name: 'Применить правки', exact: true }).click()
  await page.getByRole('button', { name: 'Сохранить проект', exact: true }).click()
  await expect(page.locator('.save-state')).toHaveText('Сохранён')
  const stored = await (await request.get(`http://127.0.0.1:4100/api/projects/${scheme.id}`)).json()
  expect(stored.scheme.schemaVersion).toBe(10)
  expect(stored.scheme.parameters.speedConditions).toEqual({ road: 'ordinary', vehicle: 'heavy' })
  expect(stored.scheme.decisionEvidence.regulation.mode).toBe('two')
  expect(
    stored.scheme.decisionEvidence.speed.parameters.every(
      (p: { confirmed: boolean }) => p.confirmed,
    ),
  ).toBe(true)
  await page.getByText('Действия с проектом', { exact: true }).click()
  const downloading = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Скачать файл проекта (JSON)', exact: true }).click()
  const download = await downloading
  expect(download.suggestedFilename()).toContain('_v10.json')
  const exported = readFileSync((await download.path())!)
  changed = true
  await page.reload()
  await page
    .getByRole('group', { name: 'Способ открытия проекта' })
    .getByRole('button', { name: 'Открыть файл' })
    .click()
  await page.locator('#scheme-file').setInputFiles({ ...file, buffer: exported })
  await page.getByRole('button', { name: /Схема движения.*Размеры и вариант/ }).click()
  await page.getByText('Справочник скорости по ПДД', { exact: true }).click()
  await expect(
    page.locator('.speed-reference').getByLabel('Вид ТС для сверки скорости'),
  ).toHaveValue('heavy')
  await page.getByText('Обоснование решений и источники', { exact: true }).click()
  await page.getByText('Сохранённые основания решений', { exact: true }).click()
  await expect(page.locator('[data-evidence="speed"]')).toContainText('основания устарели')
  await expect(page.locator('[data-evidence="regulation"]')).toContainText(
    'основания совпадают с текущими',
  )
  await page.getByRole('button', { name: /Проверка и лист.*A4 для сверки/ }).click()
  const check = page.locator('[data-check="decision-speed"]')
  await expect(check.getByRole('checkbox')).toBeDisabled()
  await check.getByRole('link', { name: 'Перейти' }).click()
  await expect(page.getByLabel('Обоснование скорости', { exact: true })).toBeFocused()
  expect(
    (await (await request.get(`http://127.0.0.1:4100/api/projects/${scheme.id}`)).json()).scheme
      .decisionEvidence,
  ).toEqual(stored.scheme.decisionEvidence)
})
