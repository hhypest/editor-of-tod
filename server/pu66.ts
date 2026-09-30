import { createHash } from 'node:crypto'
import ExcelJS from 'exceljs'

type Cell = string | number | null
type CellReader = (address: string) => Cell

export type Pu66TechnicalRow = {
  row: number
  item: string
  label: string
  statedNorm: Cell
  previous: Cell
  current: Cell
}

export type Pu66Card = {
  key: string
  cardNumber: string
  category: string
  division: string
  railway: string
  section: string
  station: string
  kilometre: number
  picket: number
  crossingOwner: string
  roadName: string
  roadKilometre: Cell
  roadCategory: Cell
  roadSignificance: string
  usage: string
  crossingType: string
  attendant: string
  trainVisibilityMetres: { rightOdd: Cell; rightEven: Cell; leftOdd: Cell; leftEven: Cell }
  trainCountPerDay: Cell
  carCountPerDay: Cell
  busRoutes: Cell
  years: { previous: string; current: string }
  technicalRows: Pu66TechnicalRow[]
}

export type Pu66Import = {
  card: Pu66Card
  filename: string
  sha256: string
  source: Buffer
}

function text(value: Cell): string {
  return value === null ? '' : String(value).trim()
}

function number(value: Cell, field: string): number {
  const parsed = Number(text(value).replace(',', '.'))
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`ПУ-66: неверное поле «${field}».`)
  return parsed
}

/** The original XLSX remains in the private database; this parser accepts only the observed card layout. */
export function extractPu66Cells(cell: CellReader): Pu66Card {
  let cardRow = 0
  for (let row = 1; row <= 20; row++) {
    if (/^Карточка\s*№\s*\d+/i.test(text(cell(`A${row}`)))) {
      if (cardRow) throw new Error('ПУ-66: найдено несколько заголовков карточки.')
      cardRow = row
    }
  }
  if (!cardRow || !text(cell(`A${cardRow + 4}`))) {
    throw new Error('ПУ-66: неизвестная форма или нет километра переезда.')
  }
  const headerRow = cardRow + 40
  if (!text(cell(`A${headerRow}`)).includes('№ п/п')) {
    throw new Error('ПУ-66: не найдена таблица технических данных ожидаемой формы.')
  }
  const cardNumber = text(cell(`A${cardRow}`)).match(/№\s*(\d+)/)?.[1]
  if (!cardNumber) throw new Error('ПУ-66: не найден номер карточки.')
  const kilometre = number(cell(`A${cardRow + 4}`), 'километр')
  const picket = number(cell(`D${cardRow + 4}`), 'пикет')
  const section = text(cell(`H${cardRow + 4}`))
  const station = text(cell(`D${cardRow + 5}`))
  if (!section && !station) throw new Error('ПУ-66: не указаны ни участок, ни станция.')
  const scope = section ? (section.match(/\((\d+)\)/)?.[1] ?? section) : `ст.${station}`

  const technicalRows: Pu66TechnicalRow[] = []
  let item = ''
  for (let row = headerRow + 3; row <= headerRow + 53; row++) {
    const label = text(cell(`B${row}`))
    if (!label) continue
    const currentItem = text(cell(`A${row}`))
    if (/^\d+$/.test(currentItem)) item = currentItem
    technicalRows.push({
      row,
      item,
      label,
      statedNorm: cell(`E${row}`),
      previous: cell(`J${row}`),
      current: cell(`L${row}`),
    })
  }
  if (technicalRows.length < 30 || !technicalRows.some((row) => row.item === '30')) {
    throw new Error('ПУ-66: таблица технических данных неполная.')
  }

  return {
    // На станции у разных переездов бывает одинаковая привязка «км:пк», поэтому для станционных
    // карточек в ключ входит номер карточки; ключ участка остаётся прежним.
    key: section
      ? `${scope}:${kilometre}:${picket}`
      : `${scope}:${kilometre}:${picket}:к${cardNumber}`,
    cardNumber,
    category: text(cell(`F${cardRow + 1}`)),
    division: text(cell(`A${cardRow + 2}`)),
    railway: text(cell(`F${cardRow + 2}`)),
    section,
    station,
    kilometre,
    picket,
    crossingOwner: text(cell(`F${cardRow + 7}`)),
    roadName: text(cell(`H${cardRow + 12}`)),
    roadKilometre: cell(`A${cardRow + 13}`),
    roadCategory: cell(`D${cardRow + 13}`),
    roadSignificance: text(cell(`H${cardRow + 13}`)),
    usage: text(cell(`F${cardRow + 6}`)),
    crossingType: text(cell(`F${cardRow + 8}`)),
    attendant: text(cell(`F${cardRow + 9}`)),
    trainVisibilityMetres: {
      rightOdd: cell(`H${cardRow + 18}`),
      rightEven: cell(`H${cardRow + 19}`),
      leftOdd: cell(`H${cardRow + 20}`),
      leftEven: cell(`H${cardRow + 21}`),
    },
    trainCountPerDay: cell(`H${cardRow + 25}`),
    carCountPerDay: cell(`H${cardRow + 26}`),
    busRoutes: cell(`C${cardRow + 28}`),
    years: {
      previous: text(cell(`J${headerRow + 2}`)),
      current: text(cell(`L${headerRow + 2}`)),
    },
    technicalRows,
  }
}

export async function parsePu66(source: Buffer, filename: string): Promise<Pu66Import> {
  if (
    source.length > 4 * 1024 * 1024 ||
    source.length < 100 ||
    !filename.toLowerCase().endsWith('.xlsx')
  ) {
    throw new Error('Нужен файл ПУ-66 в формате XLSX размером до 4 МБ.')
  }
  const workbook = new ExcelJS.Workbook()
  // ExcelJS types refer to a different Buffer declaration than @types/node 26.
  await workbook.xlsx.load(source as unknown as Parameters<typeof workbook.xlsx.load>[0])
  if (workbook.worksheets.length !== 1) throw new Error('ПУ-66: ожидается один лист.')
  const sheet = workbook.worksheets[0]!
  if (sheet.rowCount > 250 || sheet.columnCount > 35)
    throw new Error('ПУ-66: превышен размер листа.')
  function cell(address: string): Cell {
    const value = sheet.getCell(address)
    if (value.type === ExcelJS.ValueType.Formula || value.type === ExcelJS.ValueType.Error) {
      throw new Error(`ПУ-66: формула или ошибка в ${address} требует ручной сверки.`)
    }
    if (value.value === null || value.value === undefined) return null
    if (typeof value.value === 'number') return value.value
    return value.text.trim().slice(0, 2_000)
  }
  return {
    card: extractPu66Cells(cell),
    filename: filename.split(/[\\/]/).at(-1) ?? filename,
    sha256: createHash('sha256').update(source).digest('hex'),
    source,
  }
}

/** Whitelisted snapshot for a scheme; technical table, personnel and original file never enter it. */
export function schemeFields(card: Pu66Card) {
  const technical = (number: string): Cell =>
    card.technicalRows.find(
      (row) => row.item === number && /^\d+$/.test(text(row.item)) && text(row.label),
    )?.current ?? null
  return {
    referenceId: card.key,
    location: `${card.kilometre} км ${card.picket} пк`,
    axisLabel: `${card.kilometre} км ${card.picket} пк`,
    roadName: card.roadName === '0' ? '' : card.roadName,
    crossingWidthMetres: technical('7'),
  }
}

/** Local review screen; these extra fields are never returned by the scheme endpoint. */
export function localCardSummary(card: Pu66Card) {
  const length = card.technicalRows.find((row) => row.item === '8')?.current ?? null
  return {
    ...schemeFields(card),
    section: card.section,
    station: card.station,
    crossingRoadLengthMetres: length,
    carCountPerDay: card.carCountPerDay,
  }
}

/**
 * Сведения карточки для нормативных подсказок в локальном редакторе: интенсивность, категория
 * дороги, видимость и техническая таблица с графой «Норма». Не входят в JSON проекта и на лист.
 */
export function normativeFields(card: Pu66Card) {
  return {
    referenceId: card.key,
    roadCategory: card.roadCategory,
    carCountPerDay: card.carCountPerDay,
    trainCountPerDay: card.trainCountPerDay,
    trainVisibilityMetres: card.trainVisibilityMetres,
    years: card.years,
    technicalRows: card.technicalRows.map((row) => ({
      item: row.item,
      label: row.label,
      statedNorm: row.statedNorm,
      previous: row.previous,
      current: row.current,
    })),
  }
}
