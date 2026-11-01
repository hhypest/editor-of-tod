import { readFileSync, writeFileSync } from 'node:fs'
import { PNG } from 'pngjs'
import { expect, test, type Page } from './workspace-test'
import { createUnlinkedScheme } from '../../src/domain/create-scheme'
import { anchorCoordinates } from '../../src/domain/placement-workspace'
import { exportSchemeJson } from '../../src/domain/import'
import type { RoadNode } from '../../src/domain/road-layout'

function project() {
  return createUnlinkedScheme({
    referenceId: 'TEST-ROAD-DRAWING',
    locationText: 'Учебный участок',
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
}
function junction(
  scheme: ReturnType<typeof project>,
  id: number,
  x: number,
  approach: 'left' | 'right',
  side: 'up' | 'down',
): RoadNode {
  const anchors = anchorCoordinates(scheme)
  return {
    id,
    kind: 'junction',
    origin: 'manual',
    position:
      approach === 'left'
        ? { approach, from: 'L0', metres: 120 }
        : { approach, from: 'E', metres: 120 },
    side,
    roadKind: 'road',
    name: `Ветвь ${id}`,
    sideWarningRequested: false,
    sheetOffsetXSvg: x - anchors[approach === 'left' ? 'L0' : 'E'],
  }
}
async function open(page: Page, scheme: ReturnType<typeof project>) {
  await page.route('**/api/signs', (route) => route.fulfill({ json: [] }))
  await page.route('**/api/signs/catalog', (route) =>
    route.fulfill({ json: { id: 1, documentCode: 'УЧЕБНЫЙ', edition: '2026' } }),
  )
  await page.goto('/')
  await page.getByRole('button', { name: 'Открыть файл', exact: true }).click()
  await page.locator('#scheme-file').setInputFiles({
    name: 'fictional-road.json',
    mimeType: 'application/json',
    buffer: Buffer.from(exportSchemeJson(scheme)),
  })
}
async function png(page: Page) {
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Скачать PNG', exact: true }).click()
  return readFileSync((await (await download).path())!)
}
function pixel(png: PNG, x: number, y: number) {
  const offset = (Math.round(y * 2.1) * png.width + Math.round(x * 2.1)) * 4
  return [...png.data.subarray(offset, offset + 3)]
}

test('both approaches and sides share branch geometry in workspace, A4, print and real PNG', async ({
  page,
  browserName,
}, testInfo) => {
  const scheme = project()
  const variants = [
    [200, 'left', 'up'],
    [420, 'left', 'down'],
    [1280, 'right', 'up'],
    [1520, 'right', 'down'],
  ] as const
  scheme.roadLayout.nodes = variants.map(([x, approach, side], index) =>
    junction(scheme, index + 1, x, approach, side),
  )
  scheme.roadLayout.nodes[1]!.position.metres = 50
  scheme.roadLayout.nodes[3]!.position.metres = 200
  scheme.roadLayout.nextNodeId = 5
  await open(page, scheme)
  await page.getByRole('button', { name: /Знаки и объекты.*Поле и свойства/ }).click()
  const workspace = page.getByLabel('Условный рисунок примыканий')
  await expect(workspace.locator('[data-road-node-id]')).toHaveCount(4)
  await page.getByRole('button', { name: /Проверка и лист.*A4 для сверки/ }).click()
  const host = page.locator('.print-host:not(.thumbnail)')
  await expect(host.locator('[data-road-node-id]')).toHaveCount(4)
  await expect(host.locator('[data-road-problems]')).toHaveCount(0)
  for (let id = 1; id <= 4; id++)
    await expect(host.locator(`[data-road-node-id="${id}"]`)).toContainText(`Ветвь ${id}`)
  await page.emulateMedia({ media: 'print' })
  await expect(host.locator('[data-road-node-id="1"]')).toBeVisible()
  if (browserName === 'chromium') {
    const pdf = await page.pdf({ printBackground: true, preferCSSPageSize: true })
    expect(pdf.toString('latin1').match(/\/Type\s*\/Page\b/g) ?? []).toHaveLength(1)
  }
  await page.emulateMedia({ media: 'screen' })
  const bytes = await png(page),
    image = PNG.sync.read(bytes)
  expect([image.width, image.height]).toEqual([3528, 2495])
  for (const [x, , side] of variants) {
    expect(pixel(image, x + 25, side === 'up' ? 310 : 620)).toEqual([189, 189, 189])
    expect(pixel(image, x + 25, side === 'up' ? 620 : 310)).toEqual([255, 255, 255])
  }
  writeFileSync(testInfo.outputPath('four-branches-full.png'), bytes)
  await testInfo.attach('four-fictional-branches', { body: bytes, contentType: 'image/png' })
  await host
    .locator('svg')
    .first()
    .screenshot({ path: testInfo.outputPath('four-branches.png') })
})

for (const approach of ['left', 'right'] as const)
  test(`the ${approach} terminus has two branches and no straight road in PNG`, async ({
    page,
  }, testInfo) => {
    const scheme = project(),
      anchors = anchorCoordinates(scheme),
      x = approach === 'left' ? 300 : 1400
    scheme.roadLayout = {
      nextNodeId: 2,
      links: [],
      nodes: [
        {
          id: 1,
          kind: 'terminal-tee',
          origin: 'manual',
          position:
            approach === 'left'
              ? { approach, from: 'L0', metres: 200 }
              : { approach, from: 'E', metres: 200 },
          sheetOffsetXSvg: x - anchors[approach === 'left' ? 'L0' : 'E'],
          branchNames: { up: 'Север', down: 'Юг' },
        },
      ],
    }
    scheme.parameters.directions[approach] = 'Скрытое направление '.repeat(40)
    await open(page, scheme)
    await page.getByRole('button', { name: /Проверка и лист.*A4 для сверки/ }).click()
    const host = page.locator('.print-host:not(.thumbnail)')
    await expect(host.locator('[data-road-node-id="1"]')).toContainText('Север')
    await expect(host.locator('[data-road-node-id="1"]')).toContainText('Юг')
    await expect(host.locator('[data-road-problems]')).toHaveCount(0)
    const bytes = await png(page),
      image = PNG.sync.read(bytes)
    for (const y of [310, 620]) expect(pixel(image, x + 25, y)).toEqual([189, 189, 189])
    expect(pixel(image, x + (approach === 'left' ? -70 : 70), 450)).toEqual([231, 231, 231])
    expect(pixel(image, approach === 'left' ? 130 : 1580, 450)).toEqual([255, 255, 255])
    expect(pixel(image, approach === 'left' ? 470 : 1230, 450)).toEqual([189, 189, 189])
    writeFileSync(testInfo.outputPath(`${approach}-terminus-full.png`), bytes)
    await testInfo.attach(`${approach}-terminus`, { body: bytes, contentType: 'image/png' })
    await host
      .locator('svg')
      .first()
      .screenshot({ path: testInfo.outputPath(`${approach}-terminus.png`) })
  })

test('overlap blocks output, leads to node editing and is fixed by sheet offset without changing metres or objects', async ({
  page,
  request,
}) => {
  const scheme = project()
  scheme.roadLayout = {
    nextNodeId: 3,
    links: [],
    nodes: [junction(scheme, 1, 200, 'left', 'up'), junction(scheme, 2, 215, 'left', 'up')],
  }
  await open(page, scheme)
  await page.getByRole('button', { name: /Проверка и лист.*A4 для сверки/ }).click()
  const host = page.locator('.print-host:not(.thumbnail)')
  await expect(host.locator('[data-road-problems]')).toContainText('перекрываются')
  await page.getByRole('button', { name: 'Скачать PNG', exact: true }).click()
  await expect(host.getByRole('alert')).toContainText('перекрываются')
  await host
    .locator('[data-road-problems]')
    .getByRole('button', { name: 'Изменить узел №1', exact: true })
    .click()
  const editor = page.locator('[data-test="road-node-editor"]')
  await expect(editor.getByLabel('Расстояние до оси узла, м')).toHaveValue('120')
  await editor.getByLabel('Условный отступ рисунка от L0/E').fill('-100')
  await editor.getByRole('button', { name: 'Применить примыкание', exact: true }).click()
  await page.getByRole('button', { name: 'Сохранить проект', exact: true }).click()
  await expect(page.locator('.save-state')).toHaveText('Сохранён')
  const saved = await (await request.get(`http://127.0.0.1:4100/api/projects/${scheme.id}`)).json()
  expect(saved.scheme.roadLayout.nodes[0]).toMatchObject({
    position: { metres: 120 },
    sheetOffsetXSvg: -100,
  })
  expect(saved.scheme.placements).toEqual(scheme.placements)
  await page.getByRole('button', { name: /Проверка и лист.*A4 для сверки/ }).click()
  await expect(host.locator('[data-road-problems]')).toHaveCount(0)
  expect(PNG.sync.read(await png(page)).width).toBe(3528)
})

test('a post distance leader crossing a branch blocks PNG even when the signs are clear', async ({
  page,
}) => {
  const scheme = project()
  scheme.roadLayout = { nextNodeId: 2, links: [], nodes: [junction(scheme, 1, 200, 'left', 'up')] }
  scheme.placements = [
    {
      kind: 'sign-post',
      id: 72,
      generatedByTemplate: false,
      position: { anchor: 'abs', offsetXSvg: 200, offsetYSvg: 67 },
      side: 'up',
      stand: 'left',
      signIds: ['3.24_40'],
      distance: null,
      distanceLabel: '120 м',
    },
  ]
  scheme.nextPlacementId = 73
  await open(page, scheme)
  await page.getByRole('button', { name: /Проверка и лист.*A4 для сверки/ }).click()
  const host = page.locator('.print-host:not(.thumbnail)')
  await expect(host.locator('[data-road-problems]')).toContainText('объекты № 72')
  await page.getByRole('button', { name: 'Скачать PNG', exact: true }).click()
  await expect(host.getByRole('alert')).toContainText('объекты № 72')
  await page.emulateMedia({ media: 'print' })
  await expect(host.locator('.screen-preview')).toBeHidden()
  await expect(host.locator('.print-blocked-note')).toContainText('объекты № 72')
})
