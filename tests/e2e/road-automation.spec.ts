import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { PNG } from 'pngjs'
import { test, expect } from './workspace-test'
import { importSchemeJson, exportSchemeJson } from '../../src/domain/import'
import type { Scheme } from '../../src/domain/model'
for (const kind of ['junction', 'terminal-tee'] as const)
  for (const approach of ['left', 'right'] as const)
    test(`full ${kind}/${approach} preview, history, manual preservation, persistence and PNG`, async ({
      page,
      request,
    }, info) => {
      const s = importSchemeJson(
        readFileSync('tests/fixtures/frozen/projects/project-v17-road-automation-b34.json', 'utf8'),
      ).scheme
      s.id = randomUUID()
      s.crossing.referenceId = 'TEST-FULL-' + s.id.slice(0, 8)
      s.placements = []
      s.nextPlacementId = 1
      delete s.roadObjectExclusions
      s.roadLayout = {
        nextNodeId: 2,
        links: [],
        nodes: [
          {
            id: 1,
            origin: 'manual',
            position:
              approach === 'left'
                ? { approach, from: 'L0', metres: 80 }
                : { approach, from: 'E', metres: 80 },
            sheetOffsetXSvg: null,
            ...(kind === 'junction'
              ? {
                  kind,
                  side: 'down',
                  roadKind: 'road',
                  name: 'Учебная ветвь',
                  sideWarningRequested: true,
                }
              : { kind, branchNames: { up: 'Учебная А', down: 'Учебная Б' } }),
          },
        ],
      }
      const icon = new PNG({ width: 60, height: 60 })
      for (let i = 0; i < icon.data.length; i += 4) icon.data.set([255, 0, 255, 255], i)
      await page.route('**/api/signs', (r) =>
        r.fulfill({
          json: ['1.25', '3.20', '1.20.2', '1.20.3', '3.31', '4.2.2'].map((code) => ({
            code,
            width: 60,
            height: 60,
            revision: 1,
          })),
        }),
      )
      await page.route('**/api/signs/catalog', (r) =>
        r.fulfill({ json: { id: 1, documentCode: 'УЧЕБНЫЙ', edition: '2026' } }),
      )
      await page.route('**/api/signs/*/metadata*', (r) =>
        r.fulfill({
          json: {
            code: decodeURIComponent(new URL(r.request().url()).pathname.split('/')[3]!),
            width: 60,
            height: 60,
            revision: 1,
          },
        }),
      )
      await page.route(/\/api\/signs\/[^/]+\/image(?:\?|$)/, (r) =>
        r.fulfill({ contentType: 'image/png', body: PNG.sync.write(icon) }),
      )
      await page.goto('/')
      await page.getByRole('button', { name: 'Открыть файл', exact: true }).click()
      await page.locator('#scheme-file').setInputFiles({
        name: 'synthetic-full-plan.json',
        mimeType: 'application/json',
        buffer: Buffer.from(exportSchemeJson(s)),
      })
      await page.getByRole('button', { name: /Знаки и объекты.*Поле и свойства/ }).click()
      const panel = page.locator('[data-road-automation]')
      const prepare = () =>
        panel.getByRole('button', { name: 'Подготовить полный план', exact: true }).click()
      await prepare()
      expect(await panel.locator('[data-road-plan-row]').count()).toBeGreaterThan(1)
      await expect(page.locator('[data-branch-post]')).toHaveCount(0)
      await panel.getByRole('button', { name: 'Применить полный план', exact: true }).click()
      expect(await page.locator('[data-branch-post]').count()).toBeGreaterThan(0)
      await page.getByText('Действия с проектом', { exact: true }).click()
      await page.getByRole('button', { name: 'Отменить действие', exact: true }).click()
      await expect(page.locator('[data-branch-post]')).toHaveCount(0)
      await page.getByRole('button', { name: 'Повторить действие', exact: true }).click()
      await page.getByRole('button', { name: 'Сохранить проект', exact: true }).click()
      await expect(page.locator('.save-state')).toHaveText('Сохранён')
      const saved: Scheme = (
        await (await request.get(`http://127.0.0.1:4100/api/projects/${s.id}`)).json()
      ).scheme
      expect(saved.schemaVersion).toBe(17)
      expect(saved.roadLayout.automation!.outputs.length).toBeGreaterThan(1)
      expect(saved.placements.length).toBeGreaterThan(15)
      await prepare()
      await expect(
        panel.getByRole('button', { name: 'Применить полный план', exact: true }),
      ).toBeDisabled()
      await panel.getByRole('button', { name: 'Закрыть полный план', exact: true }).click()
      const id = saved.roadLayout.automation!.outputs.find(
        (o) => o.slot === (kind === 'junction' ? 'repeat' : 'main-restrict'),
      )!.placementId
      await page.getByRole('button', { name: new RegExp('^Стойка № ' + id + ':') }).click()
      await page.getByLabel('Коды знаков через запятую').fill('1.25,8.1.1_77')
      await page.getByRole('button', { name: 'Применить объект', exact: true }).click()
      await prepare()
      await expect(
        panel.getByRole('combobox', {
          name: `Решение 1:${kind === 'junction' ? 'repeat' : 'main-restrict'}`,
          exact: true,
        }),
      ).toHaveValue('keep')
      await panel.getByRole('button', { name: 'Закрыть полный план', exact: true }).click()
      await page.getByRole('button', { name: /Проверка и лист.*A4 для сверки/ }).click()
      const host = page.locator('.print-host:not(.thumbnail)')
      // The manual change is deliberately retained; approval is still a separate subject decision.
      await host.screenshot({ path: info.outputPath('full-plan-sheet.png') })
      const download = page.waitForEvent('download')
      await page.getByRole('button', { name: 'Скачать PNG', exact: true }).click()
      const png = PNG.sync.read(readFileSync((await (await download).path())!))
      expect(png.width).toBeGreaterThan(1000)
      expect(png.height).toBeGreaterThan(700)
      let pink = 0
      for (let i = 0; i < png.data.length; i += 4)
        if (png.data[i] === 255 && png.data[i + 1] === 0 && png.data[i + 2] === 255) pink++
      expect(pink).toBeGreaterThan(100)
    })
