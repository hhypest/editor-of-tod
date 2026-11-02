import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { PNG } from 'pngjs'
import { expect, test, type Page } from './workspace-test'
import { importSchemeJson, exportSchemeJson } from '../../src/domain/import'
import { anchorCoordinates } from '../../src/domain/placement-workspace'

function project() {
  const scheme = importSchemeJson(
    readFileSync('tests/fixtures/frozen/projects/project-v13-branch-b34.json', 'utf8'),
  ).scheme
  scheme.id = randomUUID()
  scheme.crossing.referenceId = 'TEST-EXCLUSION-' + scheme.id.slice(0, 8)
  const post = scheme.placements[0]!,
    node = scheme.roadLayout.nodes[0]!,
    link = scheme.roadLayout.links[0]!
  if (post.kind !== 'sign-post' || node.kind !== 'junction') throw Error('Post expected')
  node.name = 'Альфа'
  node.sheetOffsetXSvg = 250 - anchorCoordinates(scheme).L0
  post.signIds = ['9.99', '8.1.3_120']
  post.side = 'up'
  post.stand = 'left'
  link.branchPlacement = { branch: 'down', alongSvg: 140, acrossSvg: 150, rotation: 90 }
  scheme.placements = [
    post,
    {
      kind: 'element',
      id: 2,
      generatedByTemplate: false,
      elementKind: 'text',
      position: { anchor: 'abs', offsetXSvg: 1000, ySvg: 850 },
      sizeSvg: { width: 100, height: 20 },
      text: 'Учебный объект',
      fontSizeSvg: 14,
      bold: false,
    },
  ]
  scheme.roadLayout = { nextNodeId: 2, nodes: [node], links: [link] }
  scheme.nextPlacementId = 3
  scheme.signImages = {
    catalog: { id: 1, documentCode: 'УЧЕБНЫЙ', edition: '2026' },
    revisions: { '9.99': 1 },
  }
  return scheme
}
async function open(page: Page, scheme: ReturnType<typeof project>) {
  const png = new PNG({ width: 60, height: 60 })
  for (let i = 0; i < png.data.length; i += 4) png.data.set([255, 0, 255, 255], i)
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
    r.fulfill({ contentType: 'image/png', body: PNG.sync.write(png) }),
  )
  await page.goto('/')
  await page.getByRole('button', { name: 'Открыть файл', exact: true }).click()
  await page.locator('#scheme-file').setInputFiles({
    name: 'fictional-exclusion.json',
    mimeType: 'application/json',
    buffer: Buffer.from(exportSchemeJson(scheme)),
  })
  await objects(page)
}
async function objects(page: Page) {
  await page.getByRole('button', { name: /Знаки и объекты.*Поле и свойства/ }).click()
}
async function save(page: Page) {
  await page.getByRole('button', { name: 'Сохранить проект', exact: true }).click()
  await expect(page.locator('.save-state')).toHaveText('Сохранён')
}
async function pinkPixels(page: Page) {
  await page.getByRole('button', { name: /Проверка и лист.*A4 для сверки/ }).click()
  await expect(page.locator('.print-host:not(.thumbnail) [data-road-problems]')).toHaveCount(0)
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Скачать PNG', exact: true }).click()
  const png = PNG.sync.read(readFileSync((await (await download).path())!))
  let count = 0
  for (let i = 0; i < png.data.length; i += 4)
    if (png.data[i] === 255 && png.data[i + 1] === 0 && png.data[i + 2] === 255) count++
  return count
}

test('exclusion saves the complete branch post and image pins; explicit restoration returns the real PNG', async ({
  page,
  request,
}) => {
  const scheme = project()
  await open(page, scheme)
  await page.getByRole('button', { name: 'Исключить стойку', exact: true }).click()
  await expect(page.locator('[data-branch-post]')).toHaveCount(0)
  await expect(page.locator('[data-excluded-post="1"]')).toContainText('9.99')
  await save(page)
  const excluded = (
    await (await request.get(`http://127.0.0.1:4100/api/projects/${scheme.id}`)).json()
  ).scheme
  expect(excluded.schemaVersion).toBe(14)
  expect(excluded.roadObjectExclusions.objects).toEqual([
    { post: scheme.placements[0], link: scheme.roadLayout.links[0] },
  ])
  expect(excluded.signImages).toEqual(scheme.signImages)
  expect(await pinkPixels(page)).toBe(0)
  await objects(page)
  await page.getByRole('button', { name: 'Восстановить стойку № 1', exact: true }).click()
  await expect(page.locator('[data-branch-post]')).toHaveCount(1)
  await expect(page.locator('[data-excluded-road-posts]')).toHaveCount(0)
  await save(page)
  const restored = (
    await (await request.get(`http://127.0.0.1:4100/api/projects/${scheme.id}`)).json()
  ).scheme
  expect(restored.placements).toEqual(scheme.placements)
  expect(restored.roadLayout).toEqual(scheme.roadLayout)
  expect(restored.signImages).toEqual(scheme.signImages)
  expect(await pinkPixels(page)).toBeGreaterThan(100)
})

test('excluded posts survive recovery, respect unapplied input and use the common undo/redo', async ({
  page,
}) => {
  const scheme = project()
  await open(page, scheme)
  await page.getByRole('button', { name: 'Исключить стойку', exact: true }).click()
  await page.getByRole('button', { name: 'Добавить стойку', exact: true }).click()
  await expect(
    page.getByRole('button', { name: 'Восстановить стойку № 1', exact: true }),
  ).toBeDisabled()
  await expect(page.locator('.save-state')).toContainText('копия восстановления записана')
  await page.reload()
  await page
    .locator('li', { hasText: scheme.crossing.referenceId })
    .getByRole('button', { name: 'Восстановить', exact: true })
    .click()
  await objects(page)
  await expect(
    page.getByRole('button', { name: 'Восстановить стойку № 1', exact: true }),
  ).toBeDisabled()
  await page.getByRole('button', { name: 'Отменить ввод', exact: true }).click()
  await page.getByRole('button', { name: 'Восстановить стойку № 1', exact: true }).click()
  await expect(page.locator('[data-branch-post]')).toHaveCount(1)
  await page.getByText('Действия с проектом', { exact: true }).click()
  await page.getByRole('button', { name: 'Отменить действие', exact: true }).click()
  await expect(page.locator('[data-excluded-post="1"]')).toBeVisible()
  await expect(page.locator('[data-branch-post]')).toHaveCount(0)
  await page.getByRole('button', { name: 'Повторить действие', exact: true }).click()
  await expect(page.locator('[data-branch-post]')).toHaveCount(1)
})
