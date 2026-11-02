import { readFileSync, writeFileSync } from 'node:fs'
import { PNG } from 'pngjs'
import { expect, test, type Page } from './workspace-test'
import { createUnlinkedScheme } from '../../src/domain/create-scheme'
import { exportSchemeJson } from '../../src/domain/import'
import { anchorCoordinates } from '../../src/domain/placement-workspace'
import { projectDraftSheet } from '../../src/domain/draft-sheet'
import { drawSheet } from '../../src/domain/sheet-drawing'
import type { Scheme } from '../../src/domain/model'

function project(approach: 'left' | 'right', tee = false) {
  const scheme = createUnlinkedScheme({
    referenceId: 'TEST-BRANCH',
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
  const anchors = anchorCoordinates(scheme),
    x = tee ? (approach === 'left' ? 300 : 1400) : approach === 'left' ? 250 : 1250
  const position =
    approach === 'left'
      ? { approach, from: 'L0' as const, metres: 120 }
      : { approach, from: 'E' as const, metres: 120 }
  const base = {
    id: 1,
    origin: 'manual' as const,
    position,
    sheetOffsetXSvg: x - anchors[position.from],
  }
  scheme.roadLayout = {
    nextNodeId: 2,
    nodes: [
      tee
        ? { ...base, kind: 'terminal-tee', branchNames: { up: 'Север', down: 'Юг' } }
        : {
            ...base,
            kind: 'junction',
            side: approach === 'left' ? 'down' : 'up',
            roadKind: 'road',
            name: 'Учебная ветвь',
            sideWarningRequested: false,
          },
    ],
    links: [
      {
        placementId: 1,
        nodeId: 1,
        role: tee ? 'tee-branch' : 'side-warning',
        origin: 'manual',
        installation: { from: 'L0', metres: 50 },
      },
    ],
  }
  scheme.placements = [
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
  scheme.nextPlacementId = 2
  return scheme
}
async function open(page: Page, scheme: Scheme) {
  const png = new PNG({ width: 100, height: 100 })
  png.data.fill(255)
  for (let y = 0; y < 25; y++)
    for (let x = 0; x < 25; x++) png.data.set([255, 0, 255, 255], (y * 100 + x) * 4)
  await page.route('**/api/signs', (route) =>
    route.fulfill({ json: [{ code: '9.99', width: 100, height: 100, revision: 1 }] }),
  )
  await page.route('**/api/signs/catalog', (route) =>
    route.fulfill({ json: { id: 1, documentCode: 'УЧЕБНЫЙ', edition: '2026' } }),
  )
  await page.route('**/api/signs/9.99/metadata*', (route) =>
    route.fulfill({ json: { code: '9.99', width: 100, height: 100, revision: 1 } }),
  )
  await page.route(/\/api\/signs\/9\.99\/image(?:\?|$)/, (route) =>
    route.fulfill({ contentType: 'image/png', body: PNG.sync.write(png) }),
  )
  await page.goto('/')
  await page.getByRole('button', { name: 'Открыть файл', exact: true }).click()
  await page.locator('#scheme-file').setInputFiles({
    name: 'fictional-branch.json',
    mimeType: 'application/json',
    buffer: Buffer.from(exportSchemeJson(scheme)),
  })
  await page.getByRole('button', { name: /Знаки и объекты.*Поле и свойства/ }).click()
}
async function apply(page: Page) {
  await page.getByRole('button', { name: 'Применить объект', exact: true }).click()
}
async function save(page: Page) {
  await page.getByRole('button', { name: 'Сохранить проект', exact: true }).click()
  await expect(page.locator('.save-state')).toHaveText('Сохранён')
}
async function checkPng(page: Page, scheme: Scheme, ids: number[]) {
  await page.getByRole('button', { name: /Проверка и лист.*A4 для сверки/ }).click()
  const host = page.locator('.print-host:not(.thumbnail)')
  await expect(host.locator('[data-road-problems]')).toHaveCount(0)
  await expect(host.getByLabel(/Я проверил лист/)).toBeDisabled()
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Скачать PNG', exact: true }).click()
  const bytes = readFileSync((await (await download).path())!),
    image = PNG.sync.read(bytes)
  expect([image.width, image.height]).toEqual([3528, 2495])
  const drawing = drawSheet(projectDraftSheet(scheme), {
    signSizes: new Map([['9.99', { width: 100, height: 100 }]]),
    catalogLabel: '',
    revisionLabel: '',
  })
  for (const id of ids) {
    const group = drawing.nodes.find((node) => node.t === 'group' && node.objectId === id)!
    if (group.t !== 'group') throw Error('Group expected')
    const sign = group.children.find((node) => node.t === 'sign' && node.code === '9.99')!
    if (sign.t !== 'sign') throw Error('Sign expected')
    const angle = group.rotation?.degrees ?? 0,
      cx = group.rotation?.cx ?? 0,
      cy = group.rotation?.cy ?? 0
    for (const [fraction, colour] of [
      [0.1, [255, 0, 255]],
      [0.8, [255, 255, 255]],
    ] as const) {
      const dx = sign.x + sign.w * fraction - cx,
        dy = sign.y + sign.h * fraction - cy
      const [rx, ry] =
        angle === 90 ? [-dy, dx] : angle === 180 ? [-dx, -dy] : angle === 270 ? [dy, -dx] : [dx, dy]
      const x = Math.round((cx + rx) * 2.1),
        y = Math.round((cy + ry) * 2.1)
      expect([
        ...image.data.subarray((y * image.width + x) * 4, (y * image.width + x) * 4 + 3),
      ]).toEqual([...colour])
    }
    const element = host.locator(`[data-object-id="${id}"]`)
    if (angle) await expect(element).toHaveAttribute('transform', `rotate(${angle} ${cx} ${cy})`)
    await expect(element).toContainText('120 м')
    await expect(element).toContainText('50 м от L0')
  }
  return bytes
}

for (const approach of ['left', 'right'] as const)
  test(`manual ${approach} branch uses its own position, turns, moves in drawing units and survives save`, async ({
    page,
    request,
  }, testInfo) => {
    const scheme = project(approach),
      rotation = approach === 'left' ? '90' : '270',
      across = approach === 'left' ? '150' : '-150'
    await open(page, scheme)
    const fields = page.locator('[data-branch-post-fields]')
    await fields.getByLabel('Разместить стойку на ветви').check()
    await fields.getByLabel('Отступ вдоль ветви, усл. ед.').fill('140')
    await fields.getByLabel('Сдвиг поперёк ветви, усл. ед.').fill(across)
    await fields.getByLabel('Поворот стойки на листе').selectOption(rotation)
    await expect(
      page.locator('[data-road-object-link]').getByLabel('Узел для стойки'),
    ).toBeDisabled()
    await expect(page.getByLabel('Расстояние до начала работ', { exact: true })).toHaveCount(0)
    await apply(page)
    const post = page.locator('[data-branch-post="1"]')
    await expect(post).toHaveCount(1)
    await post.press('ArrowRight')
    await post.press('ArrowDown')
    await page.getByText('Действия с проектом', { exact: true }).click()
    await page.getByRole('button', { name: 'Отменить действие', exact: true }).click()
    await page.getByRole('button', { name: 'Отменить действие', exact: true }).click()
    await expect(fields.getByLabel('Отступ вдоль ветви, усл. ед.')).toHaveValue('140')
    await expect(fields.getByLabel('Сдвиг поперёк ветви, усл. ед.')).toHaveValue(across)
    await save(page)
    const saved = (
      await (await request.get(`http://127.0.0.1:4100/api/projects/${scheme.id}`)).json()
    ).scheme as Scheme
    expect(saved.schemaVersion).toBe(13)
    expect(saved.placements).toEqual(scheme.placements)
    expect(saved.roadLayout.links[0]).toMatchObject({
      installation: { from: 'L0', metres: 50 },
      branchPlacement: {
        alongSvg: 140,
        acrossSvg: Number(across),
        rotation: Number(rotation),
        branch: approach === 'left' ? 'down' : 'up',
      },
    })
    const bytes = await checkPng(page, saved, [1])
    writeFileSync(testInfo.outputPath(`${approach}-branch.png`), bytes)
  })

for (const approach of ['left', 'right'] as const)
  test(`both explicitly selected branches of a ${approach} tee render without a false beyond-tee blocker`, async ({
    page,
    request,
  }, testInfo) => {
    const scheme = project(approach, true),
      turn = approach === 'left' ? 270 : 90,
      across = approach === 'left' ? -150 : 150
    scheme.roadLayout.links[0]!.branchPlacement = {
      branch: 'up',
      alongSvg: 140,
      acrossSvg: across,
      rotation: turn,
    }
    scheme.placements.push({ ...scheme.placements[0]!, id: 2 })
    scheme.nextPlacementId = 3
    scheme.roadLayout.links.push({
      ...scheme.roadLayout.links[0]!,
      placementId: 2,
      branchPlacement: { branch: 'down', alongSvg: 140, acrossSvg: across, rotation: turn },
    })
    await open(page, scheme)
    await save(page)
    const saved = (
      await (await request.get(`http://127.0.0.1:4100/api/projects/${scheme.id}`)).json()
    ).scheme as Scheme
    const bytes = await checkPng(page, saved, [1, 2])
    writeFileSync(testInfo.outputPath(`${approach}-tee-posts.png`), bytes)
  })

test('incomplete branch input recovers without moving the applied post, and explicit detach restores its main position', async ({
  page,
  request,
}, testInfo) => {
  const scheme = project('left')
  await open(page, scheme)
  await save(page)
  const fields = page.locator('[data-branch-post-fields]')
  await fields.getByLabel('Разместить стойку на ветви').check()
  await fields.getByLabel('Отступ вдоль ветви, усл. ед.').fill('-')
  await expect(page.locator('.save-state')).toContainText('копия восстановления записана')
  await page.reload()
  await page
    .locator('li', { hasText: scheme.crossing.referenceId })
    .getByRole('button', { name: 'Восстановить', exact: true })
    .click()
  await page.getByRole('button', { name: /Знаки и объекты.*Поле и свойства/ }).click()
  await expect(fields.getByLabel('Отступ вдоль ветви, усл. ед.')).toHaveValue('-')
  await expect(page.locator('[data-branch-post]')).toHaveCount(0)
  await apply(page)
  await expect(page.locator('.workspace form.properties').getByRole('alert')).toContainText(
    'Размещение на ветви',
  )
  await fields.getByLabel('Отступ вдоль ветви, усл. ед.').fill('140')
  await fields.getByLabel('Сдвиг поперёк ветви, усл. ед.').fill('150')
  await fields.getByLabel('Поворот стойки на листе').selectOption('180')
  await apply(page)
  await save(page)
  const saved = (
    await (await request.get(`http://127.0.0.1:4100/api/projects/${scheme.id}`)).json()
  ).scheme as Scheme
  const bytes = await checkPng(page, saved, [1])
  writeFileSync(testInfo.outputPath('recovered-branch.png'), bytes)
  await page.getByRole('button', { name: /Знаки и объекты.*Поле и свойства/ }).click()
  await fields.getByLabel('Разместить стойку на ветви').uncheck()
  await apply(page)
  await save(page)
  await expect(page.locator('[data-branch-post]')).toHaveCount(0)
  const detached = (
    await (await request.get(`http://127.0.0.1:4100/api/projects/${scheme.id}`)).json()
  ).scheme as Scheme
  expect(detached.placements).toEqual(scheme.placements)
  expect(detached.roadLayout.links[0]!.branchPlacement).toBeUndefined()
})
