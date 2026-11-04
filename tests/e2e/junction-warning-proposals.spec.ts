import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { PNG } from 'pngjs'
import { expect, test, type Page } from './workspace-test'
import { importSchemeJson, exportSchemeJson } from '../../src/domain/import'
import { anchorCoordinates } from '../../src/domain/placement-workspace'

function project(approach: 'left' | 'right' = 'right', side: 'up' | 'down' = 'up') {
  const s = importSchemeJson(
    readFileSync('tests/fixtures/frozen/projects/project-v15-tee-proposals-b34.json', 'utf8'),
  ).scheme
  s.id = randomUUID()
  s.crossing.referenceId = 'TEST-JUNCTION-' + s.id.slice(0, 8)
  s.parameters.location = 'out'
  s.placements = []
  delete s.roadObjectExclusions
  s.nextPlacementId = 10
  const from = approach === 'left' ? 'L0' : 'E',
    anchors = anchorCoordinates(s)
  s.roadLayout = {
    nextNodeId: 2,
    nodes: [
      {
        id: 1,
        kind: 'junction',
        origin: 'manual',
        position:
          approach === 'left'
            ? { approach, from: 'L0', metres: 120.5 }
            : { approach, from: 'E', metres: 120.5 },
        sheetOffsetXSvg: (approach === 'left' ? 300 : 1400) - anchors[from],
        side,
        roadKind: 'road',
        name: 'Учебная дорога',
        sideWarningRequested: true,
      },
    ],
    links: [],
  }
  return s
}
async function open(page: Page, s: ReturnType<typeof project>) {
  const icon = new PNG({ width: 60, height: 60 })
  for (let i = 0; i < icon.data.length; i += 4) icon.data.set([255, 0, 255, 255], i)
  await page.route('**/api/signs', (r) =>
    r.fulfill({ json: [{ code: '1.25', width: 60, height: 60, revision: 1 }] }),
  )
  await page.route('**/api/signs/catalog', (r) =>
    r.fulfill({ json: { id: 1, documentCode: 'УЧЕБНЫЙ', edition: '2026' } }),
  )
  await page.route('**/api/signs/1.25/metadata*', (r) =>
    r.fulfill({ json: { code: '1.25', width: 60, height: 60, revision: 1 } }),
  )
  await page.route(/\/api\/signs\/1\.25\/image(?:\?|$)/, (r) =>
    r.fulfill({ contentType: 'image/png', body: PNG.sync.write(icon) }),
  )
  await page.goto('/')
  await page.getByRole('button', { name: 'Открыть файл', exact: true }).click()
  await page.locator('#scheme-file').setInputFiles({
    name: 'fictional-junction.json',
    mimeType: 'application/json',
    buffer: Buffer.from(exportSchemeJson(s)),
  })
  await page.getByRole('button', { name: /Знаки и объекты.*Поле и свойства/ }).click()
}
async function prepare(page: Page) {
  const panel = page.locator('[data-junction-warning-proposals]'),
    source = panel.getByRole('checkbox').first()
  if (!(await source.isChecked())) await source.check()
  await panel
    .getByRole('button', { name: 'Подготовить предупреждающие стойки', exact: true })
    .click()
  await expect(panel.locator('[data-junction-warning]')).toHaveCount(1)
  return panel
}
async function apply(page: Page) {
  await page
    .locator('[data-junction-warning-proposals]')
    .getByRole('button', { name: 'Применить предупреждающие стойки', exact: true })
    .click()
}
async function action(page: Page, name: string) {
  const button = page.getByRole('button', { name, exact: true })
  if (!(await button.isVisible()))
    await page.getByText('Действия с проектом', { exact: true }).click()
  await button.click()
}
async function select(page: Page) {
  await page.getByRole('button', { name: /^Стойка № 10:/ }).click()
}

for (const [approach, side, code] of [
  ['left', 'down', '8.1.3_120.5'],
  ['left', 'up', '8.1.4_120.5'],
  ['right', 'down', '8.1.4_120.5'],
  ['right', 'up', '8.1.3_120.5'],
] as const)
  test(`requested warning ${approach}/${side} previews ${code}, persists and draws real PNG`, async ({
    page,
    request,
  }, testInfo) => {
    const s = project(approach, side)
    await open(page, s)
    const panel = await prepare(page)
    await expect(panel).toContainText(code)
    await expect(panel).toContainText('Параметр не подтверждён')
    await expect(page.locator('[data-branch-post]')).toHaveCount(0)
    if (approach === 'right' && side === 'up') {
      await panel.scrollIntoViewIfNeeded()
      await panel.screenshot({ path: testInfo.outputPath('junction-warning-preview.png') })
    }
    await apply(page)
    await expect(page.locator('[data-branch-post]')).toHaveCount(1)
    await select(page)
    await expect(page.locator('[data-calculation-state="automatic"]')).toContainText('Д3/Д9')
    await expect(page.getByLabel('Замер установки стойки заполнен')).not.toBeChecked()
    await action(page, 'Отменить действие')
    await expect(page.locator('[data-branch-post]')).toHaveCount(0)
    await action(page, 'Повторить действие')
    await expect(page.locator('[data-branch-post]')).toHaveCount(1)
    await page.getByRole('button', { name: 'Сохранить проект', exact: true }).click()
    await expect(page.locator('.save-state')).toHaveText('Сохранён')
    const saved = (await (await request.get(`http://127.0.0.1:4100/api/projects/${s.id}`)).json())
      .scheme
    expect(saved.schemaVersion).toBe(17)
    expect(saved.placements[0].signIds).toEqual(['1.25', code])
    expect(saved.roadLayout.links[0]).toMatchObject({
      installation: null,
      calculation: {
        ruleId: 'project-junction-warning-v1',
        rangeBasis: { value: 300, confirmed: false },
      },
    })
    await page.getByRole('button', { name: /Проверка и лист.*A4 для сверки/ }).click()
    await expect(page.locator('.print-host:not(.thumbnail) [data-road-problems]')).toHaveCount(0)
    await expect(
      page.locator('.print-host:not(.thumbnail)').getByLabel(/Я проверил лист/),
    ).toBeDisabled()
    const downloaded = page.waitForEvent('download')
    await page.getByRole('button', { name: 'Скачать PNG', exact: true }).click()
    const png = PNG.sync.read(readFileSync((await (await downloaded).path())!))
    let pink = 0
    for (let i = 0; i < png.data.length; i += 4)
      if (png.data[i] === 255 && png.data[i + 1] === 0 && png.data[i + 2] === 255) pink++
    expect(pink).toBeGreaterThan(100)
  })

test('manual warning and exclusion survive repeat proposals until explicit decisions', async ({
  page,
  request,
}) => {
  const s = project()
  await open(page, s)
  await prepare(page)
  await apply(page)
  await select(page)
  await page.getByLabel('Коды знаков через запятую').fill('1.25,8.1.4_77')
  await page.getByRole('button', { name: 'Применить объект', exact: true }).click()
  await expect(page.locator('[data-calculation-state="modified"]')).toBeVisible()
  let panel = await prepare(page)
  await expect(panel.getByLabel('Решение для узла № 1')).toHaveValue('keep')
  await expect(
    panel.getByRole('button', { name: 'Применить предупреждающие стойки', exact: true }),
  ).toBeDisabled()
  await panel.getByRole('button', { name: 'Закрыть предложения', exact: true }).click()
  await page.getByRole('button', { name: 'Исключить стойку', exact: true }).click()
  panel = await prepare(page)
  await expect(panel).toContainText('Остаётся исключённой')
  await expect(
    panel.getByRole('button', { name: 'Применить предупреждающие стойки', exact: true }),
  ).toBeDisabled()
  await panel.getByLabel('Решение для узла № 1').selectOption('restore')
  await apply(page)
  await action(page, 'Отменить действие')
  await expect(page.locator('[data-excluded-post="10"]')).toContainText('ручная правка')
  await action(page, 'Повторить действие')
  await select(page)
  await expect(page.getByLabel('Коды знаков через запятую')).toHaveValue('1.25, 8.1.3_120.5')
  await page.getByRole('button', { name: 'Сохранить проект', exact: true }).click()
  await expect(page.locator('.save-state')).toHaveText('Сохранён')
  const saved = (await (await request.get(`http://127.0.0.1:4100/api/projects/${s.id}`)).json())
    .scheme
  expect(saved.nextPlacementId).toBe(11)
  expect(saved.roadLayout.links[0].calculation.state).toBe('automatic')
})

test('unfinished warning input recovers and locks proposal actions without accepting a plan', async ({
  page,
}) => {
  const s = project()
  await open(page, s)
  await prepare(page)
  await apply(page)
  await select(page)
  await page.getByLabel('Отступ вдоль ветви, усл. ед.').fill('-')
  await expect(
    page
      .locator('[data-junction-warning-proposals]')
      .getByRole('button', { name: 'Подготовить предупреждающие стойки', exact: true }),
  ).toBeDisabled()
  await expect(page.locator('.save-state')).toContainText('копия восстановления записана')
  await page.reload()
  await page
    .locator('li', { hasText: s.crossing.referenceId })
    .getByRole('button', { name: 'Восстановить', exact: true })
    .click()
  await page.getByRole('button', { name: /Знаки и объекты.*Поле и свойства/ }).click()
  await expect(page.getByLabel('Отступ вдоль ветви, усл. ед.')).toHaveValue('-')
  await expect(page.locator('[data-calculation-state="automatic"]')).toBeVisible()
  await page.getByRole('button', { name: 'Отменить ввод', exact: true }).click()
  const panel = await prepare(page)
  await expect(panel).toContainText('Без изменений')
})
