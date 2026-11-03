import { readFileSync } from 'node:fs'
import { PNG } from 'pngjs'
import { expect, test, type Page } from './workspace-test'
import { createUnlinkedScheme } from '../../src/domain/create-scheme'
import { exportSchemeJson } from '../../src/domain/import'
import { anchorCoordinates } from '../../src/domain/placement-workspace'

function project(approach: 'left' | 'right' = 'right') {
  const s = createUnlinkedScheme({
    referenceId: 'TEST-TEE-PLAN',
    locationText: 'Учебная дорога',
    directionLeft: 'А',
    directionRight: 'Б',
    frontMetres: '18',
    taperMetres: '10',
    bufferMetres: '10',
    location: 'out',
    approachSpeedKmh: '90',
    speedStagesKmh: ['70', '50', '40'],
    yellowTemporarySigns: false,
  })
  s.crossing.referenceId += '-' + s.id.slice(0, 8)
  const from = approach === 'left' ? 'L0' : 'E',
    anchors = anchorCoordinates(s)
  s.roadLayout = {
    nextNodeId: 2,
    nodes: [
      {
        id: 1,
        kind: 'terminal-tee',
        origin: 'manual',
        position:
          approach === 'left'
            ? { approach, from: 'L0', metres: 120 }
            : { approach, from: 'E', metres: 120 },
        sheetOffsetXSvg: (approach === 'left' ? 300 : 1400) - anchors[from],
        branchNames: { up: 'Север', down: 'Юг' },
      },
    ],
    links: [
      {
        placementId: 1,
        nodeId: 1,
        role: 'tee-branch',
        origin: 'legacy-v1',
        installation: { from: 'L0', metres: 50 },
      },
    ],
  }
  s.placements = [
    {
      kind: 'sign-post',
      id: 1,
      generatedByTemplate: false,
      position: { anchor: 'abs', offsetXSvg: 200, offsetYSvg: 0 },
      side: 'up',
      stand: 'left',
      signIds: ['9.99', '8.1.3_120'],
      distance: { by: 'metres', approach: 'left', metres: 300 },
      distanceLabel: null,
    },
  ]
  s.nextPlacementId = 3
  return s
}
async function open(page: Page, s: ReturnType<typeof project>) {
  const icon = new PNG({ width: 60, height: 60 })
  for (let i = 0; i < icon.data.length; i += 4) icon.data.set([255, 0, 255, 255], i)
  await page.route('**/api/signs', (r) =>
    r.fulfill({ json: [{ code: '9.99', width: 60, height: 60, revision: 1 }] }),
  )
  await page.route('**/api/signs/catalog', (r) =>
    r.fulfill({ json: { id: 1, documentCode: 'УЧЕБНЫЙ', edition: '2026' } }),
  )
  await page.route('**/api/signs/9.99/metadata*', (r) =>
    r.fulfill({ json: { code: '9.99', width: 60, height: 60, revision: 1 } }),
  )
  await page.route(/\/api\/signs\/9\.99\/image(?:\?|$)/, (r) =>
    r.fulfill({ contentType: 'image/png', body: PNG.sync.write(icon) }),
  )
  await page.goto('/')
  await page.getByRole('button', { name: 'Открыть файл', exact: true }).click()
  await page.locator('#scheme-file').setInputFiles({
    name: 'fictional-tee-proposals.json',
    mimeType: 'application/json',
    buffer: Buffer.from(exportSchemeJson(s)),
  })
  await page.getByRole('button', { name: /Знаки и объекты.*Поле и свойства/ }).click()
}
async function prepare(page: Page) {
  const panel = page.locator('[data-tee-proposals]'),
    source = panel.getByRole('checkbox').first()
  if (!(await source.isChecked())) await source.check()
  await panel.getByRole('button', { name: 'Подготовить предложения', exact: true }).click()
  await expect(panel.locator('[data-tee-proposal]')).toHaveCount(2)
  return panel
}
async function apply(page: Page) {
  await page
    .locator('[data-tee-proposals]')
    .getByRole('button', { name: 'Применить предложения', exact: true })
    .click()
}
async function selectPost(page: Page, id: number) {
  await page.getByRole('button', { name: new RegExp(`^Стойка № ${id}:`) }).click()
}
async function action(page: Page, name: string) {
  const button = page.getByRole('button', { name, exact: true })
  if (!(await button.isVisible()))
    await page.getByText('Действия с проектом', { exact: true }).click()
  await button.click()
}
async function save(page: Page) {
  await page.getByRole('button', { name: 'Сохранить проект', exact: true }).click()
  await expect(page.locator('.save-state')).toHaveText('Сохранён')
}

for (const approach of ['left', 'right'] as const)
  test(`explicit ${approach} tee transfer previews both branches and applies one undoable group`, async ({
    page,
    request,
  }, testInfo) => {
    const s = project(approach)
    await open(page, s)
    const panel = await prepare(page)
    await expect(page.locator('[data-branch-post]')).toHaveCount(0)
    await expect(panel).toContainText('Будет создана')
    if (approach === 'right') {
      await panel.scrollIntoViewIfNeeded()
      await panel.screenshot({ path: testInfo.outputPath('tee-proposals-preview.png') })
    }
    await apply(page)
    await expect(page.locator('[data-branch-post]')).toHaveCount(2)
    await expect(page.locator('[data-excluded-post="1"]')).toBeVisible()
    await selectPost(page, 3)
    await expect(page.locator('[data-calculation-state="automatic"]')).toBeVisible()
    await action(page, 'Отменить действие')
    await expect(page.locator('[data-branch-post]')).toHaveCount(0)
    await action(page, 'Повторить действие')
    await expect(page.locator('[data-branch-post]')).toHaveCount(2)
    await save(page)
    const saved = (await (await request.get(`http://127.0.0.1:4100/api/projects/${s.id}`)).json())
      .scheme
    expect(saved.schemaVersion).toBe(15)
    expect(saved.roadObjectExclusions.objects[0]).toEqual({
      post: s.placements[0],
      link: s.roadLayout.links[0],
    })
    expect(
      saved.roadLayout.links.map((l: { calculation: { state: string } }) => l.calculation.state),
    ).toEqual(['automatic', 'automatic'])
    expect(
      saved.roadLayout.links.every((l: { installation: unknown }) => l.installation === null),
    ).toBe(true)
    await page.getByRole('button', { name: /Проверка и лист.*A4 для сверки/ }).click()
    await expect(page.locator('.print-host:not(.thumbnail) [data-road-problems]')).toHaveCount(0)
    await expect(
      page.locator('.print-host:not(.thumbnail)').getByLabel(/Я проверил лист/),
    ).toBeDisabled()
    const download = page.waitForEvent('download')
    await page.getByRole('button', { name: 'Скачать PNG', exact: true }).click()
    const png = PNG.sync.read(readFileSync((await (await download).path())!))
    let count = 0
    for (let i = 0; i < png.data.length; i += 4)
      if (png.data[i] === 255 && png.data[i + 1] === 0 && png.data[i + 2] === 255) count++
    expect(count).toBeGreaterThan(100)
  })

test('manual and excluded tee outputs keep their values until explicit acceptance and restore', async ({
  page,
  request,
}) => {
  const s = project()
  await open(page, s)
  await prepare(page)
  await apply(page)
  await selectPost(page, 3)
  await page.getByLabel('Коды знаков через запятую').fill('9.99,8.1.3_140')
  await page.getByRole('button', { name: 'Применить объект', exact: true }).click()
  await expect(page.locator('[data-calculation-state="modified"]')).toBeVisible()
  await selectPost(page, 4)
  await page.getByRole('button', { name: 'Исключить стойку', exact: true }).click()
  let panel = await prepare(page)
  await expect(panel.getByLabel('Решение для стойки № 3')).toHaveValue('keep')
  await expect(panel.getByLabel('Решение для стойки № 4')).toHaveValue('keep')
  await expect(
    panel.getByRole('button', { name: 'Применить предложения', exact: true }),
  ).toBeDisabled()
  await expect(panel).toContainText('8.1.3_140')
  await panel.getByLabel('Решение для стойки № 3').selectOption('accept')
  await panel.getByLabel('Решение для стойки № 4').selectOption('restore')
  await apply(page)
  await expect(page.locator('[data-branch-post]')).toHaveCount(2)
  await action(page, 'Отменить действие')
  await expect(page.locator('[data-excluded-post="4"]')).toBeVisible()
  await selectPost(page, 3)
  await expect(page.getByLabel('Коды знаков через запятую')).toHaveValue('9.99, 8.1.3_140')
  await action(page, 'Повторить действие')
  await save(page)
  const saved = (await (await request.get(`http://127.0.0.1:4100/api/projects/${s.id}`)).json())
    .scheme
  expect(saved.placements.map((p: { signIds: string[] }) => p.signIds)).toEqual([
    ['9.99', '8.1.3_120'],
    ['9.99', '8.1.3_120'],
  ])
  panel = await prepare(page)
  await expect(
    panel.getByRole('button', { name: 'Применить предложения', exact: true }),
  ).toBeDisabled()
})

test('applied provenance and unfinished edits recover without accepting a preview implicitly', async ({
  page,
}) => {
  const s = project()
  await open(page, s)
  await prepare(page)
  await apply(page)
  await selectPost(page, 3)
  await page.getByLabel('Отступ вдоль ветви, усл. ед.').fill('-')
  await expect(
    page
      .locator('[data-tee-proposals]')
      .getByRole('button', { name: 'Подготовить предложения', exact: true }),
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
  await expect(page.locator('[data-branch-post]')).toHaveCount(2)
})
