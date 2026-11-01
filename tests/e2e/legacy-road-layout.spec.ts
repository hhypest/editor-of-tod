import { readFileSync } from 'node:fs'
import { expect, test } from './workspace-test'
import { legacyV1Schema } from '../../src/domain/legacy-v1'
import { schemeSchema } from '../../src/domain/model'

test('legacy road objects remain clean on opening, survive refused rebuild and save/export', async ({
  page,
}) => {
  const legacy = legacyV1Schema.parse(
    JSON.parse(readFileSync('tests/fixtures/manual-v1.json', 'utf8')),
  )
  legacy.params.junc = [
    { id: 7, app: 'R', edge: 'up', d: 125, kind: 'road', name: 'Учебная ветвь', side: true },
  ]
  legacy.params.tee = { on: false }
  legacy.objects.push(
    {
      t: 'post',
      id: 1001,
      signs: ['1.25', '8.1.1#115'],
      anchor: 'E',
      dx: 280,
      side: 'up',
      stand: 'right',
      dist: null,
      auto: 1,
      jrep: 7,
    },
    {
      t: 'post',
      id: 1002,
      signs: ['1.25', '8.1.4#125'],
      anchor: 'E',
      dx: 360,
      side: 'down',
      stand: 'right',
      dist: null,
      auto: 1,
      jside: 7,
      vert: 1,
    },
  )
  legacy.nid = 2000
  const original = JSON.stringify(legacy)
  await page.goto('/')
  await page.getByRole('button', { name: 'Открыть файл', exact: true }).click()
  await page.locator('#scheme-file').setInputFiles({
    name: 'synthetic-legacy-junction.json',
    mimeType: 'application/json',
    buffer: Buffer.from(original),
  })

  await page.getByRole('button', { name: /Схема движения.*Размеры и вариант/ }).click()
  await expect(page.getByRole('button', { name: 'Применить правки', exact: true })).toBeDisabled()
  await expect(page.locator('.save-state')).not.toContainText(/неприменённый/i)
  await page.getByRole('button', { name: /Знаки и объекты/ }).click()
  const summary = page.locator('[data-test="road-layout-summary"]')
  await expect(summary).toContainText('Учебная ветвь')
  await expect(summary).toContainText('125 м от E')
  await expect(summary.getByRole('row', { name: /Учебная ветвь/ })).toContainText(
    'Правый подход, сверху',
  )
  const build = page.getByRole('button', { name: 'Собрать черновой шаблон', exact: true })
  await expect(build).toBeEnabled()
  await build.click()
  await expect(
    page.getByRole('alert').filter({ hasText: 'геометрия ещё не поддерживается' }),
  ).toBeVisible()

  const saved = page.waitForResponse(
    (r) => r.request().method() === 'PUT' && /\/api\/projects\//.test(r.url()),
  )
  await page.getByRole('button', { name: 'Сохранить проект', exact: true }).click()
  const response = await saved
  expect(response.ok()).toBe(true)
  await expect(page.locator('.save-state')).toHaveText('Сохранён')

  await page.getByText('Действия с проектом', { exact: true }).click()
  const pending = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Скачать файл проекта', exact: true }).click()
  const download = await pending
  const path = await download.path()
  expect(path).not.toBeNull()
  const scheme = schemeSchema.parse(JSON.parse(readFileSync(path!, 'utf8')))
  expect(scheme.schemaVersion).toBe(12)
  expect(scheme.roadLayout.nodes[0]).toMatchObject({
    id: 7,
    position: { approach: 'right', from: 'E', metres: 125 },
  })
  expect(scheme.roadLayout.links.map((link) => link.placementId)).toEqual([1001, 1002])
  expect(scheme.placements.filter((p) => p.id >= 1001)).toMatchObject([
    { id: 1001, generatedByTemplate: false, signIds: ['1.25', '8.1.1_115'] },
    { id: 1002, generatedByTemplate: false, signIds: ['1.25', '8.1.4_125'] },
  ])
  expect(scheme.source).toMatchObject({ originalJson: original })

  const rawPending = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Скачать исходный файл', exact: true }).click()
  const rawDownload = await rawPending
  const rawPath = await rawDownload.path()
  expect(rawPath).not.toBeNull()
  expect(readFileSync(rawPath!, 'utf8')).toBe(original)
})
