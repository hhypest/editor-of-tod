import { expect, test } from '@playwright/test'

test('registries and help explain storage and versions without technical terms', async ({
  page,
}) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Реестры', exact: true }).click()
  await page.getByRole('button', { name: 'Карточки и нормативы', exact: true }).click()
  const registry = page.locator('section[aria-labelledby="registry-title"]')
  await expect(registry).toContainText('Данные сохраняются в базе на этом компьютере')
  await expect(
    registry.getByRole('button', { name: 'Создать резервную копию базы', exact: true }),
  ).toBeVisible()
  await expect(registry).not.toContainText(/SQLite|JSON\s*v\d+|копия SQLite|редакц/i)

  await page.locator('.top-actions').getByRole('button', { name: 'Справка', exact: true }).click()
  const glossary = page.locator('[data-help="glossary"]')
  await expect(glossary).toContainText('База на этом компьютере')
  await expect(glossary).toContainText('Файл проекта')
  await expect(glossary).toContainText('Резервная копия')
  await expect(glossary).toContainText('Версия')
})

test('project file errors explain what to do without exposing storage formats', async ({
  page,
}) => {
  await page.goto('/')
  await page
    .getByRole('group', { name: 'Способ открытия проекта' })
    .getByRole('button', { name: 'Открыть файл' })
    .click()
  const input = page.locator('#scheme-file')
  await input.setInputFiles({
    name: 'broken.json',
    mimeType: 'application/json',
    buffer: Buffer.from('{'),
  })
  await expect(page.getByRole('alert')).toHaveText(
    'Не удалось прочитать файл проекта. Выберите файл, скачанный из программы, или проверьте его содержимое.',
  )
  await expect(page.getByRole('alert')).not.toContainText(/JSON|SQLite|API/i)

  await input.setInputFiles({
    name: 'unsupported.json',
    mimeType: 'application/json',
    buffer: Buffer.from('{"schemaVersion":999}'),
  })
  await expect(page.getByRole('alert')).toHaveText(
    'Версия файла проекта не поддерживается. Выберите файл, скачанный из этой программы или её прежней версии.',
  )
  await expect(page.getByRole('alert')).not.toContainText(/JSON|SQLite|API|schemaVersion/i)
})

test('an unreadable local response offers recovery instead of technical details', async ({
  page,
}) => {
  await page.route('**/api/pu66', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<!doctype html>' }),
  )
  await page.goto('/')
  await page
    .getByRole('group', { name: 'Способ открытия проекта' })
    .getByRole('button', { name: 'Новый проект' })
    .click()
  const setupError = page
    .getByRole('alert')
    .filter({ hasText: 'Не удалось открыть реестры на этом компьютере' })
  await expect(setupError).toHaveText(
    'Не удалось открыть реестры на этом компьютере. Перезапустите программу и повторите действие.',
  )
  const blocked = page.locator('.blocked')
  await expect(blocked).toContainText('Перезапустите программу и повторите попытку.')
  await expect(setupError).not.toContainText(/JSON|SQLite|API|npm run|локальный сервер/i)
  await expect(blocked).not.toContainText(/JSON|SQLite|API|npm run|локальный сервер/i)
})

test('registry write failures explain recovery and keep the entered card', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Реестры', exact: true }).click()
  await page.getByRole('button', { name: 'Карточки и нормативы', exact: true }).click()
  const registry = page.locator('section[aria-labelledby="registry-title"]')
  const backup = registry.getByRole('button', { name: 'Создать резервную копию базы' })
  await page.route('**/api/backup', (route) => route.abort('failed'))
  await backup.click()
  await expect(registry.getByRole('alert')).toHaveText(
    'Программа не отвечает. Перезапустите её и повторите действие.',
  )
  await page.route('**/api/backup', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<!doctype html>' }),
  )
  await backup.click()
  await expect(registry.getByRole('alert')).toHaveText(
    'Программа получила неожиданный ответ. Перезапустите её и повторите действие.',
  )
  await registry.getByLabel('Ключ из проекта / ПУ-66').fill('TEST-WRITE-ERROR')
  await registry.getByLabel('Место на железной дороге').fill('Учебный участок')
  await page.route('**/api/crossings', (route) =>
    route.request().method() === 'PUT' ? route.abort('failed') : route.continue(),
  )
  await registry.getByRole('button', { name: 'Сохранить карточку', exact: true }).click()
  await expect(registry.getByRole('alert')).toHaveText(
    'Программа не отвечает. Перезапустите её и повторите действие.',
  )
  await expect(registry.getByLabel('Ключ из проекта / ПУ-66')).toHaveValue('TEST-WRITE-ERROR')
  await expect(registry.getByLabel('Место на железной дороге')).toHaveValue('Учебный участок')
})
