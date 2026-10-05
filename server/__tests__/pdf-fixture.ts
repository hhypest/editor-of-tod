import { deflateSync } from 'node:zlib'

/**
 * Минимальный генератор PDF для тестов: страницы с текстом (Helvetica, кириллица через
 * имена глифов) и растровыми изображениями. Все изображения рисуются программно; документы
 * вымышленные.
 */

export type FixtureImage = { width: number; height: number; rgb: Uint8Array }
export type FixtureItem =
  | { t: 'text'; x: number; y: number; text: string; size?: number }
  | { t: 'image'; x: number; y: number; w: number; h: number; image: FixtureImage }

const upper = 'АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ'
const lower = 'абвгдеёжзийклмнопрстуфхцчшщъыьэюя'
/** Байты 128…193 — кириллица по именам глифов Adobe (afii10017 = «А»). */
const cyrillic = [...upper, ...lower]
const glyphs = [
  ...[...upper].map((_, index) => `afii${10017 + index}`),
  ...[...lower].map((_, index) => `afii${10065 + index}`),
]

function encodeText(text: string): string {
  let result = ''
  for (const char of text) {
    const index = cyrillic.indexOf(char)
    const code = index >= 0 ? 128 + index : char.charCodeAt(0)
    if (code > 255) throw new Error(`Символ ${char} не поддерживается генератором PDF.`)
    const byte = String.fromCharCode(code)
    result += byte === '(' || byte === ')' || byte === '\\' ? `\\${byte}` : byte
  }
  return result
}

export function buildPdf(pages: FixtureItem[][]): Buffer {
  const objects: Buffer[] = []
  const add = (body: Buffer | string) => {
    objects.push(Buffer.isBuffer(body) ? body : Buffer.from(body, 'latin1'))
    return objects.length
  }
  const catalogId = add('')
  const pagesId = add('')
  const fontId = add(
    `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding << /Type /Encoding /BaseEncoding /WinAnsiEncoding /Differences [128 ${glyphs.map((name) => `/${name}`).join(' ')}] >> >>`,
  )
  const pageIds: number[] = []
  for (const items of pages) {
    const xobjects: string[] = []
    let content = ''
    for (const item of items) {
      if (item.t === 'text') {
        content += `BT /F1 ${item.size ?? 10} Tf ${item.x} ${item.y} Td (${encodeText(item.text)}) Tj ET\n`
      } else {
        const data = deflateSync(item.image.rgb)
        const id = add(
          Buffer.concat([
            Buffer.from(
              `<< /Type /XObject /Subtype /Image /Width ${item.image.width} /Height ${item.image.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${data.length} >>\nstream\n`,
              'latin1',
            ),
            data,
            Buffer.from('\nendstream', 'latin1'),
          ]),
        )
        const name = `Im${xobjects.length + 1}`
        xobjects.push(`/${name} ${id} 0 R`)
        content += `q ${item.w} 0 0 ${item.h} ${item.x} ${item.y} cm /${name} Do Q\n`
      }
    }
    const stream = Buffer.from(content, 'latin1')
    const contentId = add(
      Buffer.concat([
        Buffer.from(`<< /Length ${stream.length} >>\nstream\n`, 'latin1'),
        stream,
        Buffer.from('\nendstream', 'latin1'),
      ]),
    )
    pageIds.push(
      add(
        `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 595 842] /Contents ${contentId} 0 R /Resources << /Font << /F1 ${fontId} 0 R >> /XObject << ${xobjects.join(' ')} >> >> >>`,
      ),
    )
  }
  objects[catalogId - 1] = Buffer.from(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`, 'latin1')
  objects[pagesId - 1] = Buffer.from(
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`,
    'latin1',
  )
  const chunks: Buffer[] = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')]
  let offset = chunks[0]!.length
  const offsets: number[] = []
  objects.forEach((body, index) => {
    offsets.push(offset)
    const chunk = Buffer.concat([
      Buffer.from(`${index + 1} 0 obj\n`, 'latin1'),
      body,
      Buffer.from('\nendobj\n', 'latin1'),
    ])
    chunks.push(chunk)
    offset += chunk.length
  })
  const xref = [
    'xref',
    `0 ${objects.length + 1}`,
    '0000000000 65535 f ',
    ...offsets.map((value) => `${String(value).padStart(10, '0')} 00000 n `),
    'trailer',
    `<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>`,
    'startxref',
    String(offset),
    '%%EOF',
  ].join('\n')
  chunks.push(Buffer.from(`${xref}\n`, 'latin1'))
  return Buffer.concat(chunks)
}

type Rgb = [number, number, number]

/** Белое поле с фигурой: треугольная «кайма» и белый фон внутри либо сплошной прямоугольник. */
export function drawSign(
  width: number,
  height: number,
  shape: 'triangle' | 'plate' | 'two-plates',
  color: Rgb = [220, 30, 40],
): FixtureImage {
  const rgb = new Uint8Array(width * height * 3).fill(255)
  const set = (x: number, y: number, value: Rgb) => rgb.set(value, (y * width + x) * 3)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (shape === 'triangle') {
        // Равнобедренный треугольник вершиной вверх: кайма 4 px, белый фон внутри.
        const top = 4
        const bottom = height - 4
        if (y < top || y > bottom) continue
        const half = ((y - top) / (bottom - top)) * (width / 2 - 4)
        const dx = Math.abs(x - width / 2)
        if (dx > half) continue
        const inner = ((y - top - 8) / (bottom - top - 12)) * (width / 2 - 12)
        if (y > bottom - 4 || dx > inner) set(x, y, color)
      } else if (shape === 'plate') {
        if (x >= 3 && x < width - 3 && y >= 3 && y < height - 3) set(x, y, color)
      } else {
        const inPlate = (x0: number, x1: number) => x >= x0 && x < x1 && y >= 3 && y < height - 3
        if (inPlate(3, width / 2 - 6) || inPlate(width / 2 + 6, width - 3)) set(x, y, color)
      }
    }
  }
  return { width, height, rgb }
}

/** Вымышленный «стандарт знаков»: пункт с перечнем жёлтого фона и две страницы таблиц. */
export function fictionalSignStandard(): Buffer {
  return buildPdf([
    [
      { t: 'text', x: 57, y: 700, text: '3.2 Номера знаков, их наименования и изображения' },
      { t: 'text', x: 57, y: 686, text: 'приведены в таблицах А.1 - А.8 приложения А. Знаки' },
      { t: 'text', x: 57, y: 672, text: '1.8, 1.15 - 1.16 допускается выполнять с желтым фоном.' },
    ],
    [
      { t: 'text', x: 57, y: 800, text: 'Таблица А.1 - Учебные знаки' },
      { t: 'image', x: 60, y: 650, w: 100, h: 90, image: drawSign(60, 54, 'triangle') },
      { t: 'text', x: 100, y: 635, text: '1.8' },
      {
        t: 'image',
        x: 300,
        y: 650,
        w: 100,
        h: 90,
        image: drawSign(40, 36, 'plate', [30, 60, 160]),
      },
      { t: 'text', x: 340, y: 635, text: '1.15' },
      { t: 'image', x: 60, y: 450, w: 120, h: 40, image: drawSign(90, 30, 'two-plates') },
      { t: 'text', x: 105, y: 430, text: '1.34.1' },
      // Строка таблицы разорвана: номер этого изображения — вверху следующей страницы.
      { t: 'image', x: 300, y: 450, w: 100, h: 90, image: drawSign(60, 54, 'triangle') },
      // Под этим изображением номера нет.
      { t: 'image', x: 450, y: 300, w: 60, h: 60, image: drawSign(20, 20, 'plate') },
    ],
    [
      { t: 'text', x: 340, y: 800, text: '1.16' },
      { t: 'image', x: 60, y: 600, w: 100, h: 50, image: drawSign(40, 20, 'plate', [30, 60, 160]) },
      { t: 'text', x: 80, y: 580, text: '6.9.1 <*>' },
      { t: 'text', x: 400, y: 500, text: 'Приложение Б' },
      // Приложение Б (изображения на масштабной сетке) не входит в каталог.
      { t: 'image', x: 60, y: 300, w: 100, h: 90, image: drawSign(60, 54, 'triangle') },
      { t: 'text', x: 100, y: 280, text: '9.9' },
    ],
    [{ t: 'image', x: 60, y: 300, w: 100, h: 90, image: drawSign(60, 54, 'triangle') }],
  ])
}

/** PDF из строк текста: каждая страница — список строк сверху вниз. Текст вымышленный. */
export function textPdf(pages: string[][]): Buffer {
  return buildPdf(
    pages.map((lines) =>
      lines.map((text, index) => ({ t: 'text' as const, x: 57, y: 780 - index * 16, text })),
    ),
  )
}

/** Учебная «редакция методики»: формулировки придуманы, числа отличаются от настоящих. */
export function fictionalMethodology(alternate: number, extra = ''): Buffer {
  return textPdf([
    [
      'Таблица И.1 - Учебный отгон. На учебной дороге длина отгона принимается равной от 5 до 10 м',
      'при регулировании светофором, 14 м - с помощью знаков 2.6 и 2.7.',
    ],
    [
      '6.4.2 Учебное регулирование вводится, если длина участка:',
      `- менее 50 м при интенсивности движения от 250 до ${alternate} авт/ч.`,
      '6.4.4 Учебный разъезд со знаками 2.6 и 2.7 допускается на участках',
      'протяженностью менее 45 м с интенсивностью движения менее 260',
      `авт/ч в двух направлениях.${extra}`,
    ],
    [
      'Т а б л и ц а 5 - Учебное расстояние от регулировщика',
      'Скорость, км/ч Расстояние, м',
      '30 12',
      '50 34',
      '13.7.5 Следующий пункт.',
    ],
  ])
}
