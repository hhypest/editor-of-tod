import { mkdir, writeFile, access } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join } from 'node:path'
import ExcelJS from 'exceljs'

/** Entirely invented values; only the cell positions follow the four observed example layouts. */
export const sampleCards = [
  {
    filename: 'PU66-DEMO-101.xlsx',
    cardRow: 5,
    number: 901,
    section: 'Учебный участок Север (90001)',
    station: 'Условная станция Север',
    kilometre: 12,
    picket: 3,
    road: 'Учебная дорога А',
    roadKilometre: 2,
    width: 6.5,
    length: 11,
    cars: 120,
    trains: 8,
  },
  {
    filename: 'PU66-DEMO-102.xlsx',
    cardRow: 5,
    number: 902,
    section: 'Учебный участок Юг (90002)',
    station: 'Условная станция Юг',
    kilometre: 24,
    picket: 7,
    road: 'Учебная дорога Б',
    roadKilometre: 4,
    width: 7,
    length: 13,
    cars: 260,
    trains: 12,
  },
  {
    filename: 'PU66-DEMO-103.xlsx',
    cardRow: 5,
    number: 903,
    section: 'Учебный участок Восток (90003)',
    station: 'Условная станция Восток',
    kilometre: 36,
    picket: 1,
    road: 'Учебная дорога В',
    roadKilometre: 1,
    width: 8,
    length: 15,
    cars: 450,
    trains: 16,
  },
  {
    filename: 'PU66-DEMO-104.xlsx',
    cardRow: 4,
    number: 904,
    section: 'Учебный участок Запад (90004)',
    station: 'Условная станция Запад',
    kilometre: 48,
    picket: 5,
    road: 'Учебная дорога Г',
    roadKilometre: 6,
    width: 7.5,
    length: 12,
    cars: 80,
    trains: 6,
  },
] as const

export type SampleCard = (typeof sampleCards)[number]

// Relative to the table heading. The gaps represent subrows in the observed form.
const technicalRows = [
  3, 4, 5, 6, 7, 14, 17, 18, 19, 20, 21, 22, 23, 27, 28, 29, 36, 37, 38, 39, 40, 42, 45, 46, 47, 48,
  49, 51, 52, 53,
]

export async function createSampleWorkbook(card: SampleCard): Promise<Buffer> {
  const book = new ExcelJS.Workbook()
  book.creator = 'Учебные данные редактора СОДД'
  book.title = 'ПУ-66 — полностью вымышленный пример'
  book.subject = 'Только проверка локального импорта'
  book.created = new Date('2026-01-01T00:00:00.000Z')
  book.modified = book.created
  const sheet = book.addWorksheet('Учебная ПУ-66', {
    pageSetup: { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1 },
  })
  for (const column of 'ABCDEFGHIJKLMNO') sheet.getColumn(column).width = 13
  sheet.getColumn('B').width = 30
  sheet.getColumn('H').width = 31
  sheet.getColumn('L').width = 17

  const title = sheet.getCell('A1')
  title.value = 'УЧЕБНЫЙ ПРИМЕР · ВСЕ СВЕДЕНИЯ ВЫМЫШЛЕНЫ · НЕ ДЛЯ РАБОТЫ'
  title.font = { name: 'Arial', size: 14, bold: true, color: { argb: 'FFFFFFFF' } }
  title.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF254C62' } }
  sheet.mergeCells('A1:O1')
  sheet.getRow(1).height = 28

  const row = card.cardRow
  sheet.getCell(`A${row}`).value = `Карточка № ${card.number} · учебный пример`
  sheet.getCell(`A${row}`).font = { bold: true, size: 12 }
  sheet.getCell(`A${row + 2}`).value = 'Условное линейное подразделение'
  sheet.getCell(`F${row + 1}`).value = 'Учебная категория'
  sheet.getCell(`F${row + 2}`).value = 'Учебная железная дорога'
  sheet.getCell(`A${row + 4}`).value = card.kilometre
  sheet.getCell(`D${row + 4}`).value = card.picket
  sheet.getCell(`H${row + 4}`).value = card.section
  sheet.getCell(`D${row + 5}`).value = card.station
  sheet.getCell(`F${row + 6}`).value = 'Учебное использование'
  sheet.getCell(`F${row + 7}`).value = 'Условное подразделение'
  sheet.getCell(`F${row + 8}`).value = 'Неохраняемый (учебный)'
  sheet.getCell(`F${row + 9}`).value = 'Нет'
  sheet.getCell(`H${row + 12}`).value = card.road
  sheet.getCell(`A${row + 13}`).value = card.roadKilometre
  sheet.getCell(`D${row + 13}`).value = 'Учебная'
  sheet.getCell(`H${row + 13}`).value = 'Условное местное значение'
  for (const [offset, metres] of [450, 420, 410, 430].entries()) {
    sheet.getCell(`H${row + 18 + offset}`).value = metres
  }
  sheet.getCell(`H${row + 25}`).value = card.trains
  sheet.getCell(`H${row + 26}`).value = card.cars
  sheet.getCell(`C${row + 28}`).value = 0

  const table = row + 40
  for (const [column, value] of [
    ['A', '№ п/п'],
    ['B', 'Учебный технический показатель'],
    ['E', 'Норма: —'],
    ['J', 'Пред. год'],
    ['L', 'Тек. год'],
  ] as const) {
    const cell = sheet.getCell(`${column}${table}`)
    cell.value = value
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } }
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF376477' } }
  }
  sheet.getCell(`J${table + 2}`).value = '2025'
  sheet.getCell(`L${table + 2}`).value = '2026'

  for (let index = 0; index < technicalRows.length; index++) {
    const item = index + 1
    const technicalRow = table + technicalRows[index]!
    sheet.getCell(`A${technicalRow}`).value = item
    sheet.getCell(`B${technicalRow}`).value =
      item === 7
        ? 'Ширина проезжей части, м'
        : item === 8
          ? 'Длина пересечения автомобильной дороги, м'
          : `Учебный показатель ${item}`
    sheet.getCell(`E${technicalRow}`).value = '—'
    sheet.getCell(`J${technicalRow}`).value =
      item === 7 ? card.width : item === 8 ? card.length : item
    sheet.getCell(`L${technicalRow}`).value =
      item === 7 ? card.width : item === 8 ? card.length : item
    for (const column of ['A', 'B', 'E', 'J', 'L']) {
      sheet.getCell(`${column}${technicalRow}`).border = {
        bottom: { style: 'hair', color: { argb: 'FFD4E1E7' } },
      }
    }
  }
  sheet.getCell(`A${table + 55}`).value =
    'Только для демонстрации импорта; нормативные показатели и организации вымышлены.'
  sheet.getCell(`A${table + 55}`).font = { italic: true, color: { argb: 'FF9C3443' } }
  sheet.mergeCells(`A${table + 55}:O${table + 55}`)
  sheet.pageSetup.printArea = `A1:O${table + 55}`
  return Buffer.from(await book.xlsx.writeBuffer())
}

/** Existing generated workbooks are left intact, preserving their SHA and import revision. */
export async function generateSamples(directory: string): Promise<string[]> {
  await mkdir(directory, { recursive: true })
  for (const card of sampleCards) {
    const path = join(directory, card.filename)
    try {
      await access(path)
      throw new Error(`Файл ${path} уже существует. Удалите его вручную перед повторным созданием.`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  const paths: string[] = []
  for (const card of sampleCards) {
    const path = join(directory, card.filename)
    await writeFile(path, await createSampleWorkbook(card), { flag: 'wx', mode: 0o600 })
    paths.push(path)
  }
  return paths
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const directory =
    process.argv[2] ?? fileURLToPath(new URL('../local-input/examples-pu66/', import.meta.url))
  try {
    const paths = await generateSamples(directory)
    console.log(`Создано ${paths.length} полностью вымышленных XLSX в ${directory}:`)
    for (const path of paths) console.log(`- ${path}`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Не удалось создать примеры ПУ-66.')
    process.exitCode = 1
  }
}
