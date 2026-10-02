import { expect, test, type APIRequestContext } from '@playwright/test'
import { createSampleWorkbook, sampleCards } from '../../scripts/generate-pu66-samples'
import { localCalendarDate } from '../../src/domain/pu66-review'

const api = 'http://127.0.0.1:4100/api/pu66'
const headers = { Origin: 'http://127.0.0.1:5173' }
const key = '99001:701:3'
const successor = '99002:702:7'
let files: Promise<Array<{ name: string; data: string }>> | undefined
async function seed(request: APIRequestContext) {
  files ??= Promise.all(
    sampleCards.slice(0, 2).map(async (card, index) => ({
      name: `PU66-LIFECYCLE-${index}.xlsx`,
      data: (
        await createSampleWorkbook({
          ...card,
          section: `Учебный жизненный цикл (${99001 + index})`,
          kilometre: 701 + index,
        })
      ).toString('base64'),
    })),
  )
  const payload = { files: await files }
  const preview = await request.post(`${api}/import/preview`, { headers, data: payload })
  const plan = await preview.json()
  expect(
    (
      await request.post(`${api}/import/apply`, {
        headers,
        data: { ...payload, expectedFingerprint: plan.fingerprint },
      })
    ).ok(),
  ).toBe(true)
}
async function restore(request: APIRequestContext) {
  const status = await (await request.get(`${api}/${key}/status`)).json()
  if (!status?.excluded) return
  const input = {
    action: 'restore',
    keys: [key],
    date: localCalendarDate(new Date()),
    actor: 'Учебный составитель',
    comment: 'Очистка учебного сценария',
  }
  const plan = await (
    await request.post(`${api}/lifecycle/preview`, { headers, data: input })
  ).json()
  expect(
    (
      await request.post(`${api}/lifecycle/apply`, {
        headers,
        data: { input, expectedFingerprint: plan.fingerprint },
      })
    ).ok(),
  ).toBe(true)
}

test('excludes and restores a card through the registry, shows the old snapshot and compares a successor', async ({
  page,
  request,
}) => {
  await seed(request)
  await restore(request)
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  try {
    await page.goto('/')
    await page
      .getByRole('group', { name: 'Способ открытия проекта' })
      .getByRole('button', { name: 'Новый проект' })
      .click()
    await page.getByLabel('Поиск карточки').fill('701 км 3 пк')
    await page.getByLabel('Локальная карточка').selectOption(key)
    await expect(page.getByText('Будет закреплено в проекте')).toBeVisible()
    await page.getByLabel('Фронт работ, м').fill('18')
    await page.getByLabel('Отвод, м').fill('10')
    await page.getByLabel('Буфер, м').fill('10')
    await page.getByLabel('Вне населённого пункта').check()
    await page.getByRole('button', { name: 'Создать проект' }).click()
    await page.getByRole('button', { name: 'Реестры', exact: true }).click()
    await page.getByRole('button', { name: 'Карточки и нормативы' }).click()
    const registry = page.locator('section[aria-labelledby="pu66-lifecycle-title"]')
    await registry.getByLabel('Найти карточку').fill(key)
    await registry.getByRole('checkbox', { name: new RegExp(key) }).check()
    await registry.getByLabel('Кто выполнил').fill('Учебный составитель')
    await registry.getByLabel('Причина', { exact: true }).selectOption('other')
    await registry.getByLabel('Пояснение').fill('Проверка вымышленной передачи')
    await registry.getByLabel('Преемник (необязательно)').selectOption(successor)
    await registry.getByRole('button', { name: 'Просмотреть исключение' }).click()
    await expect(registry.getByRole('region', { name: 'План изменения ПУ-66' })).toContainText(key)
    await registry.getByRole('button', { name: 'Подтвердить исключение и создать копию' }).click()
    await expect(registry.getByRole('status')).toContainText('Исключено карточек: 1')
    expect(
      (await (await request.get(api)).json()).some(
        (card: { referenceId: string }) => card.referenceId === key,
      ),
    ).toBe(false)
    await registry.getByLabel('Список', { exact: true }).selectOption('true')
    await expect(registry.locator('.cards')).toContainText('Проверка вымышленной передачи')
    await registry.getByRole('button', { name: 'История действий' }).click()
    await expect(registry.locator('details')).toContainText('Исключение')
    await page.getByRole('button', { name: /Исходные данные.*Переезд и ПУ-66/ }).click()
    const linker = page.locator('section[aria-labelledby="pu66-link-title"]')
    await expect(linker).toContainText('Карточка исключена')
    await expect(linker.locator('p').filter({ hasText: 'Сейчас:' })).toContainText(key)
    await linker.getByRole('button', { name: `Сравнить с преемником ${successor}` }).click()
    await expect(linker.locator('table')).toContainText(successor)
    await expect(linker.locator('p').filter({ hasText: 'Сейчас:' })).toContainText(key)
    await page.getByRole('button', { name: /Проверка и лист.*A4 для сверки/ }).click()
    const finding = page.locator('[data-check="pu66-status"]')
    await expect(finding).toContainText('Карточка ПУ-66 исключена')
    await finding.getByLabel('Проверено').check()
    await expect(finding).toHaveClass(/marked/)
    await page.getByRole('button', { name: 'Реестры', exact: true }).click()
    await registry.getByRole('checkbox', { name: new RegExp(key) }).check()
    await registry.getByRole('button', { name: 'Просмотреть возврат' }).click()
    await registry.getByRole('button', { name: 'Подтвердить возврат и создать копию' }).click()
    await expect(registry.getByRole('status')).toContainText('Возвращено карточек: 1')
    await page.getByRole('button', { name: /Проверка и лист.*A4 для сверки/ }).click()
    await expect(page.locator('[data-check="pu66-status"]')).toHaveCount(0)
    expect(errors).toEqual([])
  } finally {
    await restore(request)
  }
})

test('requires a new import preview for explicit restoration of an unchanged excluded XLSX', async ({
  page,
  request,
}) => {
  await seed(request)
  await restore(request)
  const startRevision = (await (await request.get(`${api}/${key}/scheme`)).json()).revision
  const input = {
    action: 'exclude',
    keys: [key],
    date: localCalendarDate(new Date()),
    actor: 'Учебный составитель',
    reason: 'closed',
    comment: 'Учебное закрытие',
    successorKey: null,
  }
  const plan = await (
    await request.post(`${api}/lifecycle/preview`, { headers, data: input })
  ).json()
  expect(
    (
      await request.post(`${api}/lifecycle/apply`, {
        headers,
        data: { input, expectedFingerprint: plan.fingerprint },
      })
    ).ok(),
  ).toBe(true)
  try {
    await page.goto('/')
    await page.getByRole('button', { name: 'Реестры', exact: true }).click()
    const box = page.locator('#pu66-import').locator('..')
    const file = (await files!)[0]!
    await box.locator('input[type="file"]').setInputFiles({
      name: file.name,
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      buffer: Buffer.from(file.data, 'base64'),
    })
    await box.getByRole('button', { name: 'Просмотреть изменения' }).click()
    await expect(box).toContainText('Учебное закрытие')
    const apply = box.getByRole('button', { name: 'Подтвердить импорт и создать копию SQLite' })
    await expect(apply).toBeDisabled()
    await box.getByLabel('Вернуть эту карточку в действующие при импорте').check()
    await box.getByLabel('Кто возвращает').fill('Учебный составитель')
    await expect(apply).toBeDisabled()
    await box.getByRole('button', { name: 'Просмотреть изменения' }).click()
    await expect(box).toContainText('Возврат в действующие: 1')
    await apply.click()
    await expect(page.getByRole('status').filter({ hasText: 'возвращено 1' })).toBeVisible()
    expect(await (await request.get(`${api}/${key}/status`)).json()).toMatchObject({
      excluded: false,
    })
    expect(await (await request.get(`${api}/${key}/scheme`)).json()).toMatchObject({
      revision: startRevision,
    })
  } finally {
    await restore(request)
  }
})
