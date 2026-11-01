import { readFileSync } from 'node:fs'
import { PNG } from 'pngjs'
import { expect, test, type Page } from './workspace-test'
import { createUnlinkedScheme } from '../../src/domain/create-scheme'
import { exportSchemeJson } from '../../src/domain/import'

function project() {
  const scheme = createUnlinkedScheme({
    referenceId: 'TEST-MANUAL-LINK',
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
  scheme.crossing.referenceId += `-${scheme.id.slice(0, 8)}`
  scheme.roadLayout = {
    nextNodeId: 4,
    nodes: [
      {
        id: 1,
        kind: 'junction',
        origin: 'manual',
        position: { approach: 'left', from: 'L0', metres: 120 },
        side: 'down',
        roadKind: 'road',
        name: 'Альфа',
        sideWarningRequested: false,
        sheetOffsetXSvg: -250,
      },
      {
        id: 2,
        kind: 'junction',
        origin: 'manual',
        position: { approach: 'right', from: 'E', metres: 100 },
        side: 'up',
        roadKind: 'yard',
        name: 'Бета',
        sideWarningRequested: false,
        sheetOffsetXSvg: 250,
      },
      {
        id: 3,
        kind: 'terminal-tee',
        origin: 'manual',
        position: { approach: 'right', from: 'E', metres: 300 },
        branchNames: { up: 'Север', down: 'Юг' },
        sheetOffsetXSvg: 450,
      },
    ],
    links: [
      { placementId: 1, nodeId: 1, role: 'side-warning', origin: 'legacy-v1', installation: null },
      {
        placementId: 2,
        nodeId: 3,
        role: 'tee-branch',
        origin: 'manual',
        installation: { from: 'node-axis', metres: 0 },
      },
    ],
  }
  scheme.placements = [1, 2].map((id) => ({
    kind: 'sign-post',
    id,
    generatedByTemplate: false,
    position: { anchor: 'abs', offsetXSvg: 200 + id * 150, offsetYSvg: 0 },
    side: 'up',
    stand: 'right',
    signIds: ['3.24_40', '8.1.3_120'],
    distance: { by: 'metres', approach: 'left', metres: 300 },
    distanceLabel: null,
  }))
  scheme.nextPlacementId = 3
  return scheme
}
async function open(page: Page, scheme: ReturnType<typeof project>) {
  const image = new PNG({ width: 100, height: 100 })
  image.data.fill(255)
  await page.route('**/api/signs', (route) =>
    route.fulfill({
      json: ['3.24', '8.1.3'].map((code) => ({ code, width: 100, height: 100, revision: 1 })),
    }),
  )
  await page.route(/\/api\/signs\/[^/]+\/image(?:\?|$)/, (route) =>
    route.fulfill({ contentType: 'image/png', body: PNG.sync.write(image) }),
  )
  await page.goto('/')
  await page.getByRole('button', { name: 'Открыть файл', exact: true }).click()
  await page.locator('#scheme-file').setInputFiles({
    name: 'fictional-links.json',
    mimeType: 'application/json',
    buffer: Buffer.from(exportSchemeJson(scheme)),
  })
  await page.getByRole('button', { name: /Знаки и объекты.*Поле и свойства/ }).click()
}

test('explicit association edits preserve metres, plate and drawing, undo together, and unlink without deleting a post', async ({
  page,
  request,
}, testInfo) => {
  const scheme = project()
  await open(page, scheme)
  const fields = page.locator('[data-road-object-link]')
  await expect(fields.getByLabel('Узел для стойки')).toHaveValue('1')
  const list = page.getByRole('navigation', { name: 'Объекты открытого проекта' })
  await list.getByRole('button', { name: /^№ 2 ·/ }).click()
  await expect(fields.getByLabel('Узел для стойки')).toHaveValue('3')
  await expect(fields.getByLabel('Расстояние установки стойки, м')).toHaveValue('0')
  await list.getByRole('button', { name: /^№ 1 ·/ }).click()
  await expect(fields.getByLabel('Узел для стойки')).toHaveValue('1')
  await fields.getByLabel('Замер установки стойки заполнен').check()
  await fields.getByLabel('Точка отсчёта установки').selectOption('L0')
  await fields.getByLabel('Расстояние установки стойки, м').fill('50,5')
  await expect(page.getByRole('button', { name: 'Сохранить проект', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: 'Применить объект', exact: true }).click()
  await fields.screenshot({ path: testInfo.outputPath('manual-road-link.png') })
  await fields.getByLabel('Расстояние установки стойки, м').fill('55')
  await page.getByRole('button', { name: 'Отменить ввод', exact: true }).click()
  await expect(fields.getByLabel('Расстояние установки стойки, м')).toHaveValue('50.5')
  await fields.getByLabel('Узел для стойки').selectOption('2')
  await expect(fields.getByLabel('Замер установки стойки заполнен')).not.toBeChecked()
  await fields.getByLabel('Назначение стойки у узла').selectOption('main-repeat')
  await page.getByRole('button', { name: 'Применить объект', exact: true }).click()
  await page.getByText('Действия с проектом', { exact: true }).click()
  await page.getByRole('button', { name: 'Отменить действие', exact: true }).click()
  await expect(fields.getByLabel('Узел для стойки')).toHaveValue('1')
  await expect(fields.getByLabel('Расстояние установки стойки, м')).toHaveValue('50.5')
  await page.getByRole('button', { name: 'Повторить действие', exact: true }).click()
  await expect(fields.getByLabel('Узел для стойки')).toHaveValue('2')
  await fields.getByLabel('Узел для стойки').selectOption('')
  await page.getByRole('button', { name: 'Применить объект', exact: true }).click()
  await page.getByRole('button', { name: 'Сохранить проект', exact: true }).click()
  await expect(page.locator('.save-state')).toHaveText('Сохранён')
  const saved = await (await request.get(`http://127.0.0.1:4100/api/projects/${scheme.id}`)).json()
  expect(saved.scheme.placements).toEqual(scheme.placements)
  expect(saved.scheme.roadLayout.nodes).toEqual(scheme.roadLayout.nodes)
  expect(saved.scheme.roadLayout.links).toEqual([scheme.roadLayout.links[1]])
  await page
    .getByRole('button', { name: 'Скачать файл проекта', exact: true })
    .click({ trial: true })
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Скачать файл проекта', exact: true }).click()
  expect(JSON.parse(readFileSync((await (await download).path())!, 'utf8'))).toEqual(saved.scheme)
})

test('incomplete installation input is restored without applying it or mixing the node and post IDs', async ({
  page,
  request,
}) => {
  const scheme = project()
  await open(page, scheme)
  const fields = page.locator('[data-road-object-link]')
  await fields.getByLabel('Замер установки стойки заполнен').check()
  await fields.getByLabel('Расстояние установки стойки, м').fill('-')
  await expect(page.locator('.save-state')).toContainText('копия восстановления записана')
  await page.reload()
  await page
    .locator('li', { hasText: scheme.crossing.referenceId })
    .getByRole('button', { name: 'Восстановить', exact: true })
    .click()
  await page.getByRole('button', { name: /Знаки и объекты.*Поле и свойства/ }).click()
  await expect(fields.getByLabel('Расстояние установки стойки, м')).toHaveValue('-')
  await expect(page.locator('.workspace form.properties h3')).toHaveText('Свойства объекта № 1')
  await expect(page.getByRole('button', { name: 'Сохранить проект', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: 'Применить объект', exact: true }).click()
  await expect(page.locator('.workspace form.properties').getByRole('alert')).toContainText(
    'Расстояние установки стойки',
  )
  const copies = await (await request.get('http://127.0.0.1:4100/api/recovery')).json()
  expect(
    copies.some(
      (copy: { referenceId: string }) => copy.referenceId === scheme.crossing.referenceId,
    ),
  ).toBe(true)
  await fields.getByLabel('Расстояние установки стойки, м').fill('50')
  await page.getByRole('button', { name: 'Применить объект', exact: true }).click()
  await page.getByRole('button', { name: 'Сохранить проект', exact: true }).click()
  await expect(page.locator('.save-state')).toHaveText('Сохранён')
  const saved = await (await request.get(`http://127.0.0.1:4100/api/projects/${scheme.id}`)).json()
  expect(saved.scheme.roadLayout.links[0]).toMatchObject({
    nodeId: 1,
    placementId: 1,
    origin: 'manual',
    installation: { from: 'node-axis', metres: 50 },
  })
  expect(saved.scheme.placements).toEqual(scheme.placements)
})

test('a new post can be associated with the terminus, keeping an unknown installation and its two distinct IDs', async ({
  page,
  request,
}) => {
  const scheme = project()
  await open(page, scheme)
  await page.getByRole('button', { name: 'Добавить стойку', exact: true }).click()
  await page.getByLabel('Расстояние, м', { exact: true }).fill('150')
  await page.getByLabel('Коды знаков через запятую').fill('3.24_40')
  const fields = page.locator('[data-road-object-link]')
  await fields.getByLabel('Узел для стойки').selectOption('3')
  await expect(fields.getByLabel('Назначение стойки у узла')).toHaveValue('tee-branch')
  await expect(fields.getByLabel('Замер установки стойки заполнен')).not.toBeChecked()
  await page.getByRole('button', { name: 'Применить объект', exact: true }).click()
  await page.getByRole('button', { name: 'Сохранить проект', exact: true }).click()
  await expect(page.locator('.save-state')).toHaveText('Сохранён')
  const saved = await (await request.get(`http://127.0.0.1:4100/api/projects/${scheme.id}`)).json()
  expect(saved.scheme.roadLayout.links.at(-1)).toEqual({
    placementId: 3,
    nodeId: 3,
    role: 'tee-branch',
    origin: 'manual',
    installation: null,
  })
  expect(saved.scheme.nextPlacementId).toBe(4)
  expect(saved.scheme.roadLayout.nextNodeId).toBe(4)
})
