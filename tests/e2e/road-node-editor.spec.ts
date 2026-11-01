import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { expect, test, type Page } from './workspace-test'
import { schemeSchema } from '../../src/domain/model'

function project(reference: string) {
  const scheme = schemeSchema.parse(
    JSON.parse(readFileSync('tests/fixtures/frozen/projects/project-v12-native-b34.json', 'utf8')),
  )
  scheme.id = randomUUID()
  scheme.crossing.referenceId = `${reference}-${scheme.id.slice(0, 8)}`
  return scheme
}
async function open(page: Page, scheme: ReturnType<typeof project>) {
  await page.goto('/')
  await page.getByRole('button', { name: 'Открыть файл', exact: true }).click()
  await page.locator('#scheme-file').setInputFiles({
    name: `${scheme.id}.json`,
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(scheme)),
  })
  await page.getByRole('button', { name: /Знаки и объекты.*Поле и свойства/ }).click()
}

test('road edits keep linked objects and plate values, support one-step undo, and save native v12', async ({
  page,
  request,
}, testInfo) => {
  const scheme = project('TEST-ROAD-EDIT')
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await open(page, scheme)
  const editor = page.locator('[data-test="road-node-editor"]')
  await editor.getByRole('button', { name: 'Изменить узел №1', exact: true }).click()
  await editor.getByLabel('Расстояние до оси узла, м').fill('125,5')
  await editor.getByLabel('Подход примыкания').selectOption('right')
  await editor.getByLabel('Название примыкания', { exact: true }).fill('Уточнённая Альфа')
  await expect(page.getByRole('button', { name: 'Сохранить проект', exact: true })).toBeDisabled()
  await expect(page.locator('.workspace form.properties')).toHaveAttribute('inert', '')
  await expect(
    page.getByRole('button', { name: 'Собрать черновой шаблон', exact: true }),
  ).toBeDisabled()
  await editor.getByRole('button', { name: 'Применить примыкание', exact: true }).click()
  await expect(editor.getByRole('row', { name: /Уточнённая Альфа/ })).toContainText('125,5 м от E')
  await expect(
    editor.getByRole('button', { name: 'Удалить примыкание', exact: true }),
  ).toBeDisabled()
  await expect(editor).toContainText('связанные объекты')
  await editor.screenshot({ path: testInfo.outputPath('road-node-editor.png') })
  await page.getByText('Действия с проектом', { exact: true }).click()
  await page.getByRole('button', { name: 'Отменить действие', exact: true }).click()
  await expect(editor.getByLabel('Расстояние до оси узла, м')).toHaveValue('120')
  await page.getByRole('button', { name: 'Повторить действие', exact: true }).click()
  await expect(editor.getByLabel('Расстояние до оси узла, м')).toHaveValue('125.5')
  await editor.getByRole('button', { name: 'Добавить примыкание', exact: true }).click()
  await editor.getByLabel('Название примыкания', { exact: true }).fill('Новый учебный выезд')
  await editor.getByLabel('Вид примыкания').selectOption('yard')
  await editor.getByLabel('Сторона примыкания').selectOption('up')
  await editor.getByLabel('Расстояние до оси узла, м').fill('99,5')
  await editor.getByRole('button', { name: 'Применить примыкание', exact: true }).click()
  await expect(editor.getByRole('row', { name: /Новый учебный выезд/ })).toContainText(
    '99,5 м от L0',
  )
  await editor.getByRole('button', { name: 'Удалить примыкание', exact: true }).click()
  await expect(editor.getByRole('row', { name: /Новый учебный выезд/ })).toHaveCount(0)
  await page.getByRole('button', { name: 'Отменить действие', exact: true }).click()
  await expect(editor.getByRole('row', { name: /Новый учебный выезд/ })).toBeVisible()
  await page.getByRole('button', { name: 'Сохранить проект', exact: true }).click()
  await expect(page.locator('.save-state')).toHaveText('Сохранён')
  const saved = await (await request.get(`http://127.0.0.1:4100/api/projects/${scheme.id}`)).json()
  expect(saved.scheme.placements).toEqual(scheme.placements)
  expect(saved.scheme.roadLayout.links).toEqual(scheme.roadLayout.links)
  expect(saved.scheme.roadLayout.nodes[0]).toMatchObject({
    id: 1,
    name: 'Уточнённая Альфа',
    position: { approach: 'right', from: 'E', metres: 125.5 },
  })
  expect(saved.scheme.roadLayout.nodes.at(-1)).toMatchObject({
    id: 4,
    roadKind: 'yard',
    position: { approach: 'left', from: 'L0', metres: 99.5 },
  })
  expect(saved.scheme.roadLayout.nextNodeId).toBe(5)
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Скачать файл проекта', exact: true }).click()
  const exported = schemeSchema.parse(
    JSON.parse(readFileSync((await (await download).path())!, 'utf8')),
  )
  expect(exported).toEqual(saved.scheme)
  expect(errors).toEqual([])
})

test('an incomplete road edit is recovered after reload in its own namespace and never changes the applied scheme early', async ({
  page,
  request,
}) => {
  const scheme = project('TEST-ROAD-RECOVERY')
  await open(page, scheme)
  const editor = page.locator('[data-test="road-node-editor"]')
  await editor.getByRole('button', { name: 'Изменить узел №2', exact: true }).click()
  await editor.getByLabel('Расстояние до оси узла, м').fill('-')
  await editor
    .getByLabel('Название примыкания', { exact: true })
    .fill('Неприменённый учебный выезд')
  await expect(page.locator('.save-state')).toContainText('копия восстановления записана')
  const copies = await (await request.get('http://127.0.0.1:4100/api/recovery')).json()
  const sessionId = copies.find(
    (copy: { referenceId: string }) => copy.referenceId === scheme.crossing.referenceId,
  )?.sessionId
  expect(sessionId).toBeTruthy()
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Копии восстановления' })).toBeVisible()
  await page
    .locator('li', { hasText: scheme.crossing.referenceId })
    .getByRole('button', { name: 'Восстановить', exact: true })
    .click()
  await page.getByRole('button', { name: /Знаки и объекты.*Поле и свойства/ }).click()
  await expect(editor.getByLabel('Расстояние до оси узла, м')).toHaveValue('-')
  await expect(editor.getByLabel('Название примыкания', { exact: true })).toHaveValue(
    'Неприменённый учебный выезд',
  )
  await expect(page.locator('.workspace form.properties h3')).toHaveText(
    `Свойства объекта № ${scheme.placements[0]!.id}`,
  )
  await expect(page.getByRole('button', { name: 'Сохранить проект', exact: true })).toBeDisabled()
  await editor.getByRole('button', { name: 'Применить примыкание', exact: true }).click()
  await expect(editor.getByRole('alert')).toContainText('неотрицательное число')
  await expect(editor.getByRole('row', { name: /Учебный выезд Бета/ })).toContainText('100 м от E')
  await editor.getByLabel('Расстояние до оси узла, м').fill('90,5')
  await editor.getByRole('button', { name: 'Применить примыкание', exact: true }).click()
  await page.getByRole('button', { name: 'Сохранить проект', exact: true }).click()
  await expect(page.locator('.save-state')).toHaveText('Сохранён')
  const saved = await (await request.get(`http://127.0.0.1:4100/api/projects/${scheme.id}`)).json()
  expect(saved.scheme.roadLayout.nodes[1]).toMatchObject({
    id: 2,
    name: 'Неприменённый учебный выезд',
    position: { from: 'E', metres: 90.5 },
  })
  expect(saved.scheme.placements).toEqual(scheme.placements)
  expect(
    (await (await request.get('http://127.0.0.1:4100/api/recovery')).json()).some(
      (copy: { sessionId: string }) => copy.sessionId === sessionId,
    ),
  ).toBe(false)
})

test('a new terminus can be cancelled or applied with both branch names and blocks a second terminus', async ({
  page,
  request,
}) => {
  const scheme = project('TEST-TEE-EDITOR')
  scheme.roadLayout = { nextNodeId: 1, nodes: [], links: [] }
  await open(page, scheme)
  const editor = page.locator('[data-test="road-node-editor"]')
  await expect(editor.locator('[data-test="road-layout-summary"]')).toHaveCount(0)
  await editor.getByRole('button', { name: 'Добавить Т-перекрёсток', exact: true }).click()
  await editor.getByLabel('Название верхней ветви').fill('Отменённый ввод')
  await editor.getByRole('button', { name: 'Отменить ввод примыкания', exact: true }).click()
  await expect(editor.getByLabel('Название верхней ветви')).toHaveCount(0)
  await editor.getByRole('button', { name: 'Добавить Т-перекрёсток', exact: true }).click()
  await editor.getByLabel('Название верхней ветви').fill('Учебная северная ветвь')
  await editor.getByLabel('Название нижней ветви').fill('Учебная южная ветвь')
  await editor.getByLabel('Подход примыкания').selectOption('right')
  await editor.getByLabel('Расстояние до оси узла, м').fill('100,3')
  await editor.getByRole('button', { name: 'Применить примыкание', exact: true }).click()
  await expect(editor.getByRole('row', { name: /Конечный Т-перекрёсток/ })).toContainText(
    '100,3 м от E',
  )
  await expect(
    editor.getByRole('button', { name: 'Добавить Т-перекрёсток', exact: true }),
  ).toBeDisabled()
  await page.getByRole('button', { name: 'Сохранить проект', exact: true }).click()
  await expect(page.locator('.save-state')).toHaveText('Сохранён')
  const saved = await (await request.get(`http://127.0.0.1:4100/api/projects/${scheme.id}`)).json()
  expect(saved.scheme.roadLayout).toEqual({
    nextNodeId: 2,
    links: [],
    nodes: [
      {
        id: 1,
        kind: 'terminal-tee',
        origin: 'manual',
        position: { approach: 'right', from: 'E', metres: 100.3 },
        sheetOffsetXSvg: null,
        branchNames: { up: 'Учебная северная ветвь', down: 'Учебная южная ветвь' },
      },
    ],
  })
  expect(saved.scheme.placements).toEqual(scheme.placements)
  await page.getByRole('button', { name: /Проверка и лист.*A4 для сверки/ }).click()
  await expect(
    page.getByRole('listitem').filter({ hasText: 'Геометрия примыканий' }),
  ).toContainText('геометрия ещё не реализована')
})
