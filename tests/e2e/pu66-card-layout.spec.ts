import { readFileSync } from 'node:fs'
import { expect, test } from './workspace-test'
import { pu66SchemeRecordSchema } from '../../src/domain/pu66-snapshot'

const old = JSON.parse(
  readFileSync('tests/fixtures/frozen/projects/project-v11-native-b34.json', 'utf8'),
)
const longLabel =
  'Учебная видимость приближающегося поезда с автомобильной дороги со стороны учебного населённого пункта на расстоянии наблюдения от переезда, м'
const longValue = 'УчебноеЗначениеБезПробелов'.repeat(12)
const card = pu66SchemeRecordSchema.parse({
  ...old.crossing.snapshot,
  referenceId: 'TEST-PU66-LAYOUT',
  roadName: 'Учебная дорога с длинным названием между условными населёнными пунктами Альфа и Бета',
  railwayLocation: { section: longValue, station: 'Учебная станция' },
  visibility: {
    ...old.crossing.snapshot.visibility,
    technical: [{ item: '5', label: longLabel, previous: 111, current: 222 }],
  },
})

for (const width of [1708, 1080, 640])
  test(`long PU-66 labels and values remain inside the card at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 1100 })
    await page.route('**/api/pu66', (r) =>
      r.fulfill({
        json: [
          {
            referenceId: card.referenceId,
            location: card.location,
            roadName: card.roadName,
            section: card.railwayLocation!.section,
            station: card.railwayLocation!.station,
            revision: card.revision,
            verification: null,
          },
        ],
      }),
    )
    await page.route('**/api/pu66/TEST-PU66-LAYOUT/scheme', (r) => r.fulfill({ json: card }))
    await page.goto('/')
    await page.getByRole('button', { name: 'Новый проект', exact: true }).click()
    await page.getByLabel('Локальная карточка').selectOption(card.referenceId)
    const preview = page.locator('[aria-labelledby="new-scheme-card-title"] .preview')
    await expect(preview).toContainText(longLabel)
    await expect(preview).toContainText(longValue)
    await expect(preview).toContainText('2029: 111; 2030: 222')
    const layout = await preview.evaluate((element) => {
      const outer = element.closest('.card')!.getBoundingClientRect()
      return {
        fits: [...element.querySelectorAll('dt,dd')].every((cell) => {
          const rect = cell.getBoundingClientRect()
          return (
            rect.left >= outer.left &&
            rect.right <= outer.right &&
            cell.scrollWidth <= cell.clientWidth + 1
          )
        }),
        pageWidth: document.documentElement.scrollWidth,
        viewport: window.innerWidth,
      }
    })
    expect(layout.fits).toBe(true)
    expect(layout.pageWidth).toBeLessThanOrEqual(layout.viewport + 1)
    if (width === 1708) {
      await preview.screenshot({ path: testInfo.outputPath('fictional-card-details.png') })
      await page.screenshot({
        path: testInfo.outputPath('fictional-card-layout.png'),
        fullPage: true,
      })
    }
  })
