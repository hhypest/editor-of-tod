import type { DraftSheet } from './draft-sheet'

/**
 * Векторный лист A4 (альбомная ориентация) в координатах рабочей области 1680 × 1188.
 * Функция только раскладывает применённые данные проекта: она не выбирает знаки и
 * не проверяет нормативную применимость расстановки.
 */
export const SHEET_WIDTH = 1680
export const SHEET_HEIGHT = 1188

/** Верх и низ проезжей части, линия ограждения зоны и кромка полосы (как в рабочей области). */
const ROAD_TOP = 380
const ROAD_BOTTOM = 540
const CARRIAGEWAY_TOP = 400
const CARRIAGEWAY_BOTTOM = 520
const CENTRE_LINE = 460
const ZONE_LINE = 466
const LANE_EDGE = 512
const DIMENSION_Y = 722
const SIGN_HEIGHT = 38
const POLE_BAR = 11
const SIGN_GAP = 2.5

export type SignSize = { width: number; height: number }

export type SheetNode =
  | {
      t: 'rect'
      x: number
      y: number
      w: number
      h: number
      fill?: string
      stroke?: string
      sw?: number
      rx?: number
    }
  | {
      t: 'line'
      x1: number
      y1: number
      x2: number
      y2: number
      stroke?: string
      sw?: number
      dash?: string
      arrows?: boolean
    }
  | { t: 'path'; d: string; fill?: string; stroke?: string; sw?: number }
  | {
      t: 'text'
      x: number
      y: number
      text: string
      size: number
      anchor?: 'start' | 'middle' | 'end'
      bold?: boolean
      italic?: boolean
      underline?: boolean
      fill?: string
      rotate?: number
      cls?: string
    }
  | { t: 'sign'; x: number; y: number; w: number; h: number; code: string }
  | { t: 'symbol'; id: 'cone' | 'reg' | 'truck'; x: number; y: number; w: number; h: number }
  | {
      t: 'group'
      objectId?: number
      cls?: string
      box?: [number, number, number, number]
      children: SheetNode[]
    }

export type SheetDrawing = {
  nodes: SheetNode[]
  /** Габариты объектов составителя: для проверок перед печатью и выделения. */
  objectBoxes: Array<{
    id: number
    kind: 'sign-post' | 'element'
    /** Знаки стойки или сам элемент: по ним проверяется перекрытие стоек. */
    box: [number, number, number, number]
    /** Всё, что рисует объект, включая выноску и подпись расстояния: для проверки границ листа. */
    extent: [number, number, number, number]
  }>
  /** Коды знаков, для которых нужен PNG (после подстановки имени из архива). */
  signCodes: string[]
  /** Блоки текста, которые не поместились в отведённую высоту. */
  overflow: string[]
}

export type SheetOptions = {
  /** Размеры PNG активного каталога по коду; без записи знак рисуется квадратом. */
  signSizes: ReadonlyMap<string, SignSize>
  /** Строка источника изображений знаков для условных обозначений. */
  catalogLabel: string
  /** Состояние сохранения проекта для служебной строки листа. */
  revisionLabel: string
  /**
   * Выпускной лист: без отметки «черновик» и служебных строк. Включается только после явной
   * проверки составителем; расстановка при этом не становится нормативно подтверждённой.
   */
  release?: boolean
}

/** Приблизительная ширина строки Arial: достаточно для переноса без измерения в браузере. */
export function textWidth(text: string, size: number): number {
  let units = 0
  for (const char of text) {
    if (char === ' ') units += 0.28
    else if ('.,:;!|il1()[]\'"«»'.includes(char)) units += 0.3
    else if (/[А-ЯЁA-ZШЩЖМЮ]/.test(char)) units += 0.68
    else if (/[0-9]/.test(char)) units += 0.556
    else units += 0.54
  }
  return units * size
}

/** Перенос по словам; слишком длинное слово переносится посимвольно. */
export function wrapText(text: string, width: number, size: number): string[] {
  const lines: string[] = []
  for (const paragraph of text.split('\n')) {
    let line = ''
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const candidate = line ? `${line} ${word}` : word
      if (textWidth(candidate, size) <= width) {
        line = candidate
        continue
      }
      if (line) lines.push(line)
      if (textWidth(word, size) <= width) {
        line = word
        continue
      }
      line = ''
      for (const char of word) {
        if (textWidth(line + char, size) > width && line) {
          lines.push(line)
          line = ''
        }
        line += char
      }
    }
    lines.push(line)
  }
  return lines
}

function metres(value: number): string {
  return String(Math.round(value * 100) / 100).replace('.', ',')
}

function blank(value: string, placeholder = '______________'): string {
  return value.trim() || placeholder
}

/**
 * Имя PNG в архиве: знак 3.24 со значением 50 хранится как «3.24» («3.24_ж»),
 * остальные значения — как «3.24_70». Код проекта не меняется, меняется только файл.
 */
export function signImageCode(code: string, available: ReadonlySet<string>): string {
  if (available.has(code)) return code
  const speed = /^3\.24_50(_ж)?$/.exec(code)
  if (speed && available.has(`3.24${speed[1] ?? ''}`)) return `3.24${speed[1] ?? ''}`
  return code
}

/** Знаки, которые можно нарисовать без PNG: ограничение скорости и табличка расстояния. */
export function drawableWithoutImage(code: string): boolean {
  return /^3\.24(_\d+)?(_ж)?$/.test(code) || /^8\.1\.1_\d+$/.test(code)
}

function signSize(code: string, sizes: ReadonlyMap<string, SignSize>): [number, number] {
  const known = sizes.get(code)
  const plate = code.startsWith('8.') && !code.startsWith('8.22')
  const height = plate ? SIGN_HEIGHT * 0.62 : SIGN_HEIGHT
  if (!known || known.height <= 0) return plate ? [height * 2, height] : [height, height]
  return [(height * known.width) / known.height, height]
}

function codeLabel(code: string): string {
  return code.split(/[_#]/)[0] ?? code
}

type Box = [number, number, number, number]

function drawPost(
  post: Extract<DraftSheet['placements'][number], { kind: 'sign-post' }>,
  options: SheetOptions,
  available: ReadonlySet<string>,
): { nodes: SheetNode[]; box: Box; extent: Box; codes: string[] } {
  const x = post.x
  const yc = post.y
  const codes = post.signIds.map((code) => signImageCode(code, available))
  const sizes = codes.map((code) => signSize(code, options.signSizes))
  const rowWidth = sizes.reduce((sum, [w]) => sum + w, 0) + SIGN_GAP * (sizes.length - 1)
  const top = yc - SIGN_HEIGHT / 2
  const right = post.stand === 'right'
  let sx = right ? x - POLE_BAR - rowWidth : x + POLE_BAR
  const nodes: SheetNode[] = []
  codes.forEach((code, index) => {
    const [w, h] = sizes[index]!
    nodes.push({ t: 'sign', x: sx, y: yc - h / 2, w, h, code })
    const labelX = sx + w / 2 + 4.5
    nodes.push(
      post.side === 'down'
        ? {
            t: 'text',
            x: labelX,
            y: top + SIGN_HEIGHT + 5,
            text: codeLabel(post.signIds[index]!),
            size: 12.5,
            anchor: 'end',
            rotate: -90,
          }
        : {
            t: 'text',
            x: labelX,
            y: top - 5,
            text: codeLabel(post.signIds[index]!),
            size: 12.5,
            anchor: 'start',
            rotate: -90,
          },
    )
    sx += w + SIGN_GAP
  })
  const barEnd = right ? x - POLE_BAR : x + POLE_BAR
  nodes.push(
    { t: 'line', x1: barEnd, y1: yc, x2: x, y2: yc, sw: 2 },
    { t: 'line', x1: x, y1: yc - 9, x2: x, y2: yc + 9, sw: 2.6 },
  )
  if (post.distanceLabel !== null) {
    const labelX = right ? x + 14 : x - 3
    if (post.side === 'down') {
      const end = 655 + post.dy
      nodes.push(
        { t: 'line', x1: x, y1: yc + 9, x2: x, y2: end, sw: 1.2 },
        {
          t: 'text',
          x: labelX,
          y: end,
          text: post.distanceLabel,
          size: 12.5,
          anchor: 'start',
          rotate: -90,
          cls: 'object-caption',
        },
      )
    } else {
      const end = 245 + post.dy
      nodes.push(
        { t: 'line', x1: x, y1: yc - 9, x2: x, y2: end, sw: 1.2 },
        {
          t: 'text',
          x: labelX,
          y: end,
          text: post.distanceLabel,
          size: 12.5,
          anchor: 'end',
          rotate: -90,
          cls: 'object-caption',
        },
      )
    }
  }
  const left = Math.min(x, right ? x - POLE_BAR - rowWidth : x) - 3
  const rightEdge = Math.max(x, right ? x : x + POLE_BAR + rowWidth) + 3
  // Повёрнутые коды над (под) знаками и выноска с подписью расстояния.
  const codeLength = Math.max(0, ...post.signIds.map((code) => textWidth(codeLabel(code), 12.5)))
  let extentTop = post.side === 'down' ? top - 4 : top - 5 - codeLength
  let extentBottom =
    post.side === 'down' ? top + SIGN_HEIGHT + 5 + codeLength : top + SIGN_HEIGHT + 4
  let extentLeft = left
  let extentRight = rightEdge
  if (post.distanceLabel !== null) {
    const labelLength = textWidth(post.distanceLabel, 12.5)
    if (post.side === 'down') extentBottom = Math.max(extentBottom, 655 + post.dy + labelLength)
    else extentTop = Math.min(extentTop, 245 + post.dy - labelLength)
    const labelX = right ? x + 14 : x - 3
    extentLeft = Math.min(extentLeft, labelX - 14)
    extentRight = Math.max(extentRight, labelX + 4)
  }
  return {
    nodes,
    box: [left, top - 4, rightEdge - left, SIGN_HEIGHT + 8],
    extent: [extentLeft, extentTop, extentRight - extentLeft, extentBottom - extentTop],
    codes,
  }
}

function drawElement(
  item: Extract<DraftSheet['placements'][number], { kind: 'element' }>,
  available: ReadonlySet<string>,
  options: SheetOptions,
): { nodes: SheetNode[]; box: Box; codes: string[] } {
  const { x, y, width: w, height: h } = item
  if (item.elementKind === 'text') {
    const size = item.fontSize
    const lines = (item.text ?? '').split('\n')
    const nodes: SheetNode[] = lines.map((line, index) => ({
      t: 'text',
      x,
      y: y + index * size * 1.25,
      text: line,
      size,
      bold: item.bold,
    }))
    const width = Math.max(10, ...lines.map((line) => textWidth(line, size)))
    return { nodes, box: [x - 3, y - size, width + 6, size * 1.25 * lines.length + 4], codes: [] }
  }
  const box: Box = [x - 3, y - 3, w + 6, h + 6]
  if (item.elementKind === 'reg')
    return { nodes: [{ t: 'symbol', id: 'reg', x, y, w, h }], box, codes: [] }
  if (item.elementKind === 'cone')
    return { nodes: [{ t: 'symbol', id: 'cone', x, y, w, h }], box, codes: [] }
  if (item.elementKind === 'pit')
    return {
      nodes: [{ t: 'rect', x, y, w, h, fill: 'url(#sheet-hatch)', stroke: '#222', sw: 1.2 }],
      box,
      codes: [],
    }
  const mandatory = signImageCode('4.2.2', available)
  if (item.elementKind === 'car') {
    const bodyHeight = (w * 50) / 120
    return {
      nodes: [
        { t: 'symbol', id: 'truck', x, y, w, h: bodyHeight },
        { t: 'line', x1: x + 6, y1: y + bodyHeight - 4, x2: x + 6, y2: y + h - 22, sw: 1.5 },
        { t: 'rect', x: x - 1, y: y + h - 23, w: 23, h: 23, fill: '#333' },
        { t: 'sign', x, y: y + h - 22, w: 21, h: 21, code: mandatory },
      ],
      box,
      codes: [mandatory],
    }
  }
  // Переносной комплекс: красно-белая планка на стойках, знаки 1.25 и 4.2.2 над ней.
  const warning = signImageCode('1.25', available)
  const nodes: SheetNode[] = []
  for (let index = 0; index < 6; index++) {
    nodes.push({
      t: 'rect',
      x: x + 2 + (index * (w - 4)) / 6,
      y: y + h * 0.56,
      w: (w - 4) / 6,
      h: h * 0.12,
      fill: index % 2 ? '#fff' : '#e4032e',
    })
  }
  nodes.push(
    { t: 'rect', x: x + 2, y: y + h * 0.56, w: w - 4, h: h * 0.12, stroke: '#000', sw: 1 },
    { t: 'rect', x: x + 2, y: y + h * 0.5, w: 2.5, h: h * 0.5, fill: '#000' },
    { t: 'rect', x: x + w - 4.5, y: y + h * 0.5, w: 2.5, h: h * 0.5, fill: '#000' },
    { t: 'rect', x: x - 2, y: y + h - 2.5, w: 10, h: 2.5, fill: '#000' },
    { t: 'rect', x: x + w - 8, y: y + h - 2.5, w: 10, h: 2.5, fill: '#000' },
    {
      t: 'sign',
      x: x + w * 0.12,
      y,
      w: h * 0.52 * 1.12,
      h: h * 0.52,
      code: warning,
    },
    { t: 'sign', x: x + w * 0.58, y: y + h * 0.05, w: h * 0.45, h: h * 0.45, code: mandatory },
  )
  void options
  return { nodes, box, codes: [warning, mandatory] }
}

function textBlock(
  lines: Array<{ text: string; size: number; bold?: boolean; gap?: number; underline?: boolean }>,
  x: number,
  y: number,
  width: number,
  maxBottom: number,
  anchor: 'start' | 'middle',
  name: string,
  overflow: string[],
): SheetNode[] {
  const nodes: SheetNode[] = []
  let cursor = y
  for (const line of lines) {
    cursor += line.gap ?? 0
    for (const part of wrapText(line.text, width, line.size)) {
      cursor += line.size * 1.25
      nodes.push({
        t: 'text',
        x: anchor === 'middle' ? x + width / 2 : x,
        y: cursor,
        text: part,
        size: line.size,
        bold: line.bold,
        underline: line.underline,
        anchor,
      })
    }
  }
  if (cursor > maxBottom) overflow.push(name)
  return nodes
}

function titleSuffix(sheet: DraftSheet): string {
  if (sheet.template === 'b33') return 'направлений по одной полосе с помощью регулировщиков'
  if (sheet.regulationMode === 'signs')
    return 'направлений по одной полосе (очерёдность — знаки 2.6, 2.7)'
  if (sheet.regulationMode === 'one') return 'направлений по одной полосе с помощью регулировщика'
  if (sheet.regulationMode === 'two') return 'направлений по одной полосе с помощью регулировщиков'
  // Способ регулирования ещё не выбран: заголовок его не называет.
  return 'направлений по одной полосе'
}

/**
 * Примечания листа — только решения, которые составитель явно записал в проекте.
 * Типовые примечания образцов (время работ, зачехление знаков, передача схемы и т. п.)
 * не печатаются: их применимость и источники ещё не проверены (docs/standards.md).
 */
function notes(sheet: DraftSheet): string[] {
  const list: string[] = []
  if (sheet.template === 'b34') {
    if (sheet.regulationMode === 'signs')
      list.push('Очерёдность проезда — знаки 2.6 и 2.7 (решение составителя).')
    else if (sheet.regulationMode === 'one')
      list.push('Пропуск транспорта регулирует один регулировщик (решение составителя).')
    else if (sheet.regulationMode === 'two')
      list.push(
        'Пропуск транспорта регулируют два регулировщика у начала и конца места работ (решение составителя).',
      )
  }
  if (sheet.settlement !== 'auto')
    list.push(
      `Расстояния установки знаков приняты для участка ${sheet.settlement === 'in' ? 'в населённом пункте' : 'вне населённого пункта'} (решение составителя).`,
    )
  if (sheet.signSize !== 'auto')
    list.push(`Типоразмер знаков ${sheet.signSize} (решение составителя).`)
  return list.map((text, index) => `${index + 1}. ${text}`)
}

const legendTexts = {
  reg: 'Регулировщик с жезлом (диском с красным сигналом или световозвращателем)',
  complex: 'Комплекс дорожных знаков переносной',
  car: 'Автомобиль прикрытия',
  cone: 'Конус дорожный',
  pit: 'Место производства работ',
} as const

/** Раскладка всего листа; одинаково используется на экране, в миниатюре и при печати. */
export function drawSheet(sheet: DraftSheet, options: SheetOptions): SheetDrawing {
  const available = new Set(options.signSizes.keys())
  const nodes: SheetNode[] = []
  const overflow: string[] = []
  const codes = new Set<string>()
  const { L0, L1, Z0, Z1, E, AX } = sheet.anchors
  const shortFront = sheet.template === 'b34'

  // Шапка: разработчик, наименование и сведения о работах, утверждение и согласование.
  const title = sheet.titleBlock
  nodes.push(
    ...textBlock(
      [
        { text: 'Разработано:', size: 17, bold: true },
        { text: blank(title.developer.organization), size: 13, gap: 6 },
        { text: blank(title.developer.name), size: 13, gap: 6 },
        { text: blank(title.developer.date, '«___» ____________ 20__г.'), size: 13, gap: 4 },
      ],
      20,
      40,
      330,
      235,
      'start',
      'Разработано',
      overflow,
    ),
  )
  const object = [
    'Наименование объекта: железнодорожный переезд',
    sheet.crossingFromPu66?.location || sheet.referenceId,
    sheet.location,
  ]
    .filter(Boolean)
    .join(' ')
  const road = sheet.crossingFromPu66?.roadName
  nodes.push(
    ...textBlock(
      [
        {
          text: `Организация движения и ограждение зоны дорожных работ,\nна полосе движения с пропуском транспортных средств встречных\n${titleSuffix(sheet)}`,
          size: 20,
          bold: true,
        },
        { text: `Наименование организации: ${blank(title.work.organization)}`, size: 14, gap: 6 },
        { text: `${object}${road ? `, а/д «${road}»` : ''}`, size: 14, gap: 3 },
        {
          text: `Вид и характер дорожных работ: ${blank(title.work.description)}`,
          size: 14,
          gap: 3,
        },
        {
          text: `Срок выполнения работ: ${blank(title.work.period, '__.__.20__г. с __ ч. __ мин. до __ ч. __ мин')}`,
          size: 15,
          gap: 4,
        },
        {
          text: `Ответственные за проведение дорожных работ: ${[
            title.responsible[0],
            title.responsible[1],
          ]
            .map((person) => blank(person))
            .join('; ')}`,
          size: 14,
          gap: 3,
        },
      ],
      380,
      14,
      920,
      252,
      'middle',
      'Наименование и сведения о работах',
      overflow,
    ),
  )
  const year = blank(title.agreement.year, '20__')
  nodes.push(
    ...textBlock(
      [
        { text: 'Утверждаю:', size: 17, bold: true },
        { text: blank(title.approver.position), size: 13, gap: 3 },
        { text: blank(title.approver.organization), size: 13 },
        { text: blank(title.approver.name), size: 13 },
        { text: `«____» _______________ ${year}г.`, size: 13, gap: 3 },
        { text: 'Согласовано:', size: 17, bold: true, gap: 10 },
        { text: blank(title.agreement.position), size: 13, gap: 3 },
        { text: blank(title.agreement.name), size: 13 },
        { text: `«____» _______________ ${year}г.`, size: 13, gap: 3 },
      ],
      1370,
      14,
      300,
      300,
      'start',
      'Утверждаю и согласовано',
      overflow,
    ),
  )
  if (!options.release)
    nodes.push({
      t: 'text',
      x: SHEET_WIDTH / 2,
      y: 268,
      text: 'ЧЕРНОВИК · ДЛЯ ВНУТРЕННЕЙ СВЕРКИ',
      size: 13,
      bold: true,
      anchor: 'middle',
      fill: '#9b2934',
      cls: 'draft-mark',
    })

  // Проезжая часть: обочины, полосы, разметка и направления движения.
  nodes.push(
    { t: 'rect', x: 0, y: ROAD_TOP, w: SHEET_WIDTH, h: ROAD_BOTTOM - ROAD_TOP, fill: '#e7e7e7' },
    {
      t: 'rect',
      x: 0,
      y: CARRIAGEWAY_TOP,
      w: SHEET_WIDTH,
      h: CARRIAGEWAY_BOTTOM - CARRIAGEWAY_TOP,
      fill: '#bdbdbd',
    },
    { t: 'line', x1: 0, y1: 401.5, x2: SHEET_WIDTH, y2: 401.5, stroke: '#fff', sw: 3 },
    { t: 'line', x1: 0, y1: 518.5, x2: SHEET_WIDTH, y2: 518.5, stroke: '#fff', sw: 3 },
    {
      t: 'line',
      x1: 0,
      y1: CENTRE_LINE,
      x2: SHEET_WIDTH,
      y2: CENTRE_LINE,
      stroke: '#fff',
      sw: 1.6,
      dash: '18 14',
    },
  )
  const laneArrow = (x: number, y: number, left: boolean): SheetNode => ({
    t: 'path',
    d: left
      ? `M${x} ${y} l12 -6 v4 h28 v4 h-28 v4 z`
      : `M${x + 40} ${y} l-12 -6 v4 h-28 v4 h28 v4 z`,
    fill: '#fff',
  })
  nodes.push(
    laneArrow(30, 430, true),
    laneArrow(SHEET_WIDTH - 80, 430, true),
    laneArrow(30, 490, false),
    laneArrow(SHEET_WIDTH - 80, 490, false),
  )
  // Подписи направлений не переносятся: длинная подпись останавливает печать.
  const directionWidth = 420
  if (textWidth(`← ${sheet.directions.left.trim()}`, 14) > directionWidth)
    overflow.push('Направление слева')
  if (textWidth(`${sheet.directions.right.trim()} →`, 14) > directionWidth)
    overflow.push('Направление справа')
  if (sheet.directions.left.trim())
    nodes.push({ t: 'text', x: 10, y: 372, text: `← ${sheet.directions.left.trim()}`, size: 14 })
  if (sheet.directions.right.trim())
    nodes.push({
      t: 'text',
      x: SHEET_WIDTH - 10,
      y: 560,
      text: `${sheet.directions.right.trim()} →`,
      size: 14,
      anchor: 'end',
    })

  // Зона работ: сплошная штриховка для Б.33 и сплошного фронта Б.34, конусы по отводу и зоне.
  if (!shortFront)
    nodes.push({
      t: 'rect',
      x: Z0,
      y: 476,
      w: Z1 - Z0,
      h: 36,
      fill: 'url(#sheet-hatch)',
      stroke: '#222',
      sw: 1.5,
    })
  else if (sheet.frontStyle === 'solid')
    nodes.push({
      t: 'rect',
      x: Z0 + 4,
      y: 476,
      w: Math.max(10, Z1 - Z0 - 30),
      h: 36,
      fill: 'url(#sheet-hatch)',
      stroke: '#222',
      sw: 1.5,
    })
  const cones: Array<[number, number]> = []
  const taperSteps = shortFront ? 6 : 4
  for (let index = 0; index <= taperSteps; index++)
    cones.push([
      L0 + ((L1 - L0) * index) / taperSteps,
      LANE_EDGE + ((ZONE_LINE - LANE_EDGE) * index) / taperSteps,
    ])
  const along = Math.max(1, Math.round((Z1 - L1) / 18))
  for (let index = 1; index <= along; index++)
    cones.push([L1 + ((Z1 - L1) * index) / along, ZONE_LINE])
  if (!shortFront)
    for (let index = 1; index <= 4; index++)
      cones.push([Z1 + ((E - Z1) * index) / 4, ZONE_LINE + ((LANE_EDGE - ZONE_LINE) * index) / 4])
  cones
    .sort((a, b) => a[1] - b[1])
    .forEach(([cx, cy]) =>
      nodes.push({ t: 'symbol', id: 'cone', x: cx - 6, y: cy - 6.5, w: 12, h: 13.6 }),
    )

  // Ось переезда, подписи и ширина проезжей части из закреплённой карточки.
  nodes.push(
    { t: 'rect', x: AX - 1.5, y: 370, w: 3, h: 180, fill: '#111' },
    {
      t: 'text',
      x: AX - 10,
      y: 368,
      text: 'ось ж/д переезда',
      size: 12.5,
      anchor: 'start',
      rotate: -90,
    },
  )
  const axisLabel = sheet.crossingFromPu66?.axisLabel
  if (axisLabel) {
    nodes.push({ t: 'text', x: AX + 5, y: 368, text: axisLabel, size: 12.5, rotate: -90 })
    if (textWidth(axisLabel, 12.5) > 100) overflow.push('Подпись оси переезда')
  }
  // Ширина выводится так, как записана в карточке; ширина полосы не вычисляется.
  const width = sheet.crossingFromPu66?.carriagewayWidthMetres.trim()
  if (width)
    nodes.push({
      t: 'text',
      x: AX + 25,
      y: 432,
      text: `ширина проезжей части ${width} м`,
      size: 14,
    })

  // Размерная цепочка отвода, участка перед фронтом, фронта и выходного отвода.
  const edges = [
    sheet.dimensionChain[0]?.startX ?? L0,
    ...sheet.dimensionChain.map((part) => part.endX),
  ]
  edges.forEach((x) =>
    nodes.push({ t: 'line', x1: x, y1: CARRIAGEWAY_BOTTOM, x2: x, y2: 735, sw: 1.3 }),
  )
  sheet.dimensionChain.forEach((part) => {
    nodes.push(
      {
        t: 'line',
        x1: part.startX + 1,
        y1: DIMENSION_Y,
        x2: part.endX - 1,
        y2: DIMENSION_Y,
        sw: 1.3,
        arrows: true,
      },
      {
        t: 'text',
        x: (part.startX + part.endX) / 2,
        y: DIMENSION_Y - 8,
        text: metres(part.enteredMetres),
        size: 14,
        anchor: 'middle',
        cls: 'dimension-label',
      },
    )
  })

  // Объекты составителя: стойки со знаками и элементы.
  const objectBoxes: SheetDrawing['objectBoxes'] = []
  for (const item of sheet.placements) {
    const drawn =
      item.kind === 'sign-post'
        ? drawPost(item, options, available)
        : drawElement(item, available, options)
    drawn.codes.forEach((code) => codes.add(code))
    objectBoxes.push({
      id: item.id,
      kind: item.kind,
      box: drawn.box,
      extent: 'extent' in drawn ? (drawn.extent as Box) : drawn.box,
    })
    nodes.push({
      t: 'group',
      objectId: item.id,
      cls: `placed-object ${item.kind === 'sign-post' ? 'sign-post' : item.elementKind}`,
      box: drawn.box,
      children: drawn.nodes,
    })
  }

  // Условные обозначения.
  nodes.push({
    t: 'text',
    x: 60,
    y: 800,
    text: 'Условные обозначения:',
    size: 17,
    bold: true,
    underline: true,
  })
  const kinds = new Set(
    sheet.placements.flatMap((item) =>
      item.kind === 'element' && item.elementKind !== 'text' ? [item.elementKind] : [],
    ),
  )
  kinds.add('cone')
  // Штриховка зоны Б.33 и сплошного фронта Б.34 рисуется всегда, поэтому обозначение нужно всегда.
  if (!shortFront || sheet.frontStyle === 'solid') kinds.add('pit')
  const legend: Array<['sign' | keyof typeof legendTexts, string]> = [
    [
      'sign',
      sheet.yellowTemporarySigns
        ? 'Дорожный знак с жёлтым световозвращающим фоном изображения'
        : 'Дорожный знак',
    ],
    ...(['reg', 'complex', 'car', 'cone', 'pit'] as const)
      .filter((kind) => kinds.has(kind))
      .map((kind): ['sign' | keyof typeof legendTexts, string] => [
        kind,
        kind === 'pit' && shortFront
          ? sheet.frontStyle === 'solid'
            ? 'Место производства работ (сплошной фронт)'
            : 'Места производства работ (частичный фронт)'
          : legendTexts[kind],
      ]),
  ]
  const legendStep = legend.length > 6 ? 44 : 52
  legend.forEach(([kind, text], index) => {
    const y = 822 + index * legendStep
    if (kind === 'sign') {
      const code = signImageCode('1.25', available)
      if (available.has(code)) {
        codes.add(code)
        nodes.push({ t: 'sign', x: 95, y, w: 40, h: 36, code })
      } else {
        // Обозначение знака вообще, а не конкретного PNG: без архива рисуется контур треугольника.
        nodes.push({
          t: 'path',
          d: `M115 ${y + 2} L135 ${y + 34} L95 ${y + 34} Z`,
          fill: sheet.yellowTemporarySigns ? '#ffd200' : '#fff',
          stroke: '#e30613',
          sw: 4,
        })
      }
    } else {
      const size = {
        reg: [22, 30],
        cone: [18, 21],
        complex: [44, 38],
        car: [48, 46],
        pit: [50, 24],
      }[kind]
      const drawn = drawElement(
        {
          kind: 'element',
          id: 0,
          x: 115 - size[0]! / 2,
          y: y + 18 - size[1]! / 2 + (kind === 'car' ? 2 : 0),
          width: size[0]!,
          height: size[1]!,
          elementKind: kind,
          text: null,
          fontSize: 14,
          bold: false,
        },
        available,
        options,
      )
      drawn.codes.forEach((code) => codes.add(code))
      nodes.push(...drawn.nodes)
    }
    nodes.push({ t: 'text', x: 170, y: y + 24, text: `- ${text}`, size: 15 })
  })
  if (!options.release)
    nodes.push({
      t: 'text',
      x: 20,
      y: SHEET_HEIGHT - 46,
      text: options.catalogLabel,
      size: 11,
      italic: true,
      fill: '#777',
    })

  // Примечания.
  const noteLines = notes(sheet)
  const noteSize = noteLines.length > 8 ? 13.5 : 14.5
  if (noteLines.length || !options.release)
    nodes.push(
      ...textBlock(
        [
          { text: 'Примечание:', size: 17, bold: true, underline: true },
          ...noteLines.map((text) => ({ text, size: noteSize, gap: 3 })),
        ],
        900,
        780,
        760,
        1150,
        'start',
        'Примечание',
        overflow,
      ),
    )
  if (!options.release)
    nodes.push(
      {
        t: 'text',
        x: 20,
        y: SHEET_HEIGHT - 30,
        text: shortFront
          ? 'Схема по рис. Б.34 ОДМ 218.6.019-2016: рабочая зона длиной менее 30 м, пропуск встречных направлений по одной полосе.'
          : 'Схема по рис. Б.33 ОДМ 218.6.019-2016: рабочая зона длиной 30 м и более, пропуск встречных направлений по одной полосе с помощью регулировщиков.',
        size: 11,
        italic: true,
        fill: '#777',
      },
      {
        t: 'text',
        x: 20,
        y: SHEET_HEIGHT - 14,
        text: `${options.revisionLabel} Черновик: расстановка и применимость не подтверждены.`,
        size: 11,
        italic: true,
        fill: '#9b2934',
      },
    )

  return { nodes, objectBoxes, signCodes: [...codes], overflow }
}

/** Пары стоек, чьи знаки перекрываются на листе. */
export function overlappingPosts(drawing: SheetDrawing): Array<[number, number]> {
  const posts = drawing.objectBoxes.filter((item) => item.kind === 'sign-post')
  const pairs: Array<[number, number]> = []
  for (let first = 0; first < posts.length; first++) {
    const [ax, ay, aw, ah] = posts[first]!.box
    for (let second = first + 1; second < posts.length; second++) {
      const [bx, by, bw, bh] = posts[second]!.box
      if (ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by)
        pairs.push([posts[first]!.id, posts[second]!.id])
    }
  }
  return pairs
}

/** Объекты, которые вместе с выносками и подписями выходят за поле листа. */
export function objectsOutside(drawing: SheetDrawing): number[] {
  return drawing.objectBoxes
    .filter(
      ({ extent: [x, y, w, h] }) => x < 0 || y < 0 || x + w > SHEET_WIDTH || y + h > SHEET_HEIGHT,
    )
    .map((item) => item.id)
}
