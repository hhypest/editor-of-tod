import { createHash } from 'node:crypto'
import { PNG } from 'pngjs'
import type { SignImport } from './signs.ts'

/**
 * Извлечение изображений знаков из PDF ГОСТ Р 52290.
 *
 * В приложении А стандарта (таблицы А.1–А.8) каждый знак вставлен отдельным растровым
 * изображением, а его номер напечатан текстом под изображением в той же ячейке. Программа
 * берёт изображения между заголовком «Таблица А.1» и заголовком «Приложение Б» и сопоставляет
 * каждое с ближайшим номером ниже в той же колонке. Если в ячейке несколько изображений
 * (примеры знаков индивидуального проектирования), они получают коды «N», «N_v2», «N_v3».
 * Составитель проверяет результат перед записью и может исправить номер или исключить
 * изображение. Жёлтые варианты «_ж» строятся по перечню пункта 3.2 стандарта.
 */

type PdfJs = typeof import('pdfjs-dist/legacy/build/pdf.mjs')
let pdfjs: Promise<PdfJs> | null = null

/**
 * pdf.js загружается только при разборе PDF. В Node.js он работает без отдельного потока:
 * обработчик подключается явно, чтобы попасть и в сборку исполняемого файла. Предупреждения
 * об отсутствии необязательного модуля отрисовки не нужны: страницы не рисуются.
 */
function loadPdfJs(): Promise<PdfJs> {
  pdfjs ??= (async () => {
    const original = { log: console.log, warn: console.warn }
    const quiet =
      (write: (...args: unknown[]) => void) =>
      (...args: unknown[]) => {
        if (!(typeof args[0] === 'string' && args[0].startsWith('Warning: Cannot'))) write(...args)
      }
    console.log = quiet(original.log)
    console.warn = quiet(original.warn)
    try {
      const worker = await import('pdfjs-dist/legacy/build/pdf.worker.mjs')
      ;(globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = worker
      return await import('pdfjs-dist/legacy/build/pdf.mjs')
    } finally {
      console.log = original.log
      console.warn = original.warn
    }
  })()
  return pdfjs
}

export const PDF_SIGN_LIMITS = { maxImages: 2_000, maxSide: 2_048 } as const
const YELLOW: [number, number, number] = [254, 220, 0]
const LABEL = /^(\d{1,2}(?:\.\d{1,2}){1,3})\s*(<\*>)?$/
const WHITE = 235

export type PdfSignImage = {
  /** «страница-порядковый номер на странице». */
  key: string
  page: number
  /** Номер знака под изображением или null, если найти его не удалось. */
  code: string | null
  /** Номер отмечен «<*>»: приведён пример изображения знака индивидуального проектирования. */
  example: boolean
  png: Buffer
  width: number
  height: number
  sha256: string
}

export type YellowRule = {
  /** Пункт стандарта, из которого взят перечень. */
  clause: string
  /** Текст перечня так, как он напечатан. */
  text: string
  /** Диапазоны и отдельные номера: ['1.8', '1.18-1.21', …]. */
  items: string[]
}

export type PdfSignExtraction = {
  pages: { first: number; last: number } | null
  images: PdfSignImage[]
  yellow: YellowRule | null
}

type Matrix = [number, number, number, number, number, number]
type Placed = { page: number; index: number; objectId: string; box: Box }
type Box = { x0: number; y0: number; x1: number; y1: number }
type Label = { page: number; code: string; example: boolean; cx: number; y: number }
type TextItem = { str: string; x: number; y: number; width: number }

function multiply(a: Matrix, b: Matrix): Matrix {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ]
}

/** Прямоугольник единичного квадрата изображения после преобразования. */
function unitBox(m: Matrix): Box {
  const xs = [m[4], m[4] + m[0], m[4] + m[2], m[4] + m[0] + m[2]]
  const ys = [m[5], m[5] + m[1], m[5] + m[3], m[5] + m[1] + m[3]]
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) }
}

export function compareSignCodes(a: string, b: string): number {
  return a.localeCompare(b, 'ru', { numeric: true })
}

/** Порядок номеров знаков: 1.18 < 1.20.1 < 1.21 < 3.18.1 < 3.25. */
function numericKey(code: string): number[] {
  return code.split('.').map(Number)
}

function inRange(code: string, from: string, to: string): boolean {
  const compare = (a: number[], b: number[]) => {
    for (let index = 0; index < Math.max(a.length, b.length); index++) {
      const difference = (a[index] ?? -1) - (b[index] ?? -1)
      if (difference) return difference
    }
    return 0
  }
  const key = numericKey(code)
  // «3.11 - 3.16» включает и разновидности 3.16.x.
  const upper = numericKey(to)
  const prefix = key.slice(0, upper.length)
  return compare(key, numericKey(from)) >= 0 && compare(prefix, upper) <= 0
}

/** Номера из перечня пункта 3.2 с учётом диапазонов «1.18 - 1.21». */
export function yellowCodes(rule: YellowRule | null, codes: readonly string[]): Set<string> {
  const result = new Set<string>()
  if (!rule) return result
  for (const item of rule.items) {
    const [from, to] = item.split('-')
    for (const code of codes) {
      if (to ? inRange(code, from!, to) : code === from) result.add(code)
    }
  }
  return result
}

/**
 * Перечень знаков, допускающих жёлтый фон: «Знаки 1.8, 1.15, … 6.22 допускается выполнять
 * с желтым фоном». Возвращает null, если такой фразы в тексте нет.
 */
export function findYellowRule(text: string): YellowRule | null {
  const flat = text.replace(/\s+/g, ' ')
  const match =
    /(\d+(?:\.\d+)+)\s+Номера знаков, их наименования и изображения.{0,240}?\s+Знаки\s+([\d.,\s\-–—]+?)\s*допускается выполнять с ж[её]лтым фоном/u.exec(
      flat,
    )
  if (!match) return null
  const items = match[2]!
    .split(',')
    .map((item) => item.trim().replace(/\s*[-–—]\s*/g, '-'))
    .filter((item) => /^\d+(\.\d+)+(-\d+(\.\d+)+)?$/.test(item))
  if (!items.length) return null
  return {
    clause: match[1]!,
    text: `Знаки ${match[2]!.trim()} допускается выполнять с желтым фоном.`,
    items,
  }
}

function toRgba(image: {
  width: number
  height: number
  kind: number
  data: Uint8Array | Uint8ClampedArray
}): Uint8Array {
  const { width, height, kind, data } = image
  const rgba = new Uint8Array(width * height * 4)
  if (kind === 3) {
    rgba.set(data.subarray(0, rgba.length))
  } else if (kind === 2) {
    for (let source = 0, target = 0; target < rgba.length; source += 3, target += 4) {
      rgba[target] = data[source]!
      rgba[target + 1] = data[source + 1]!
      rgba[target + 2] = data[source + 2]!
      rgba[target + 3] = 255
    }
  } else if (kind === 1) {
    const rowBytes = (width + 7) >> 3
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const bit = (data[y * rowBytes + (x >> 3)]! >> (7 - (x & 7))) & 1
        const value = bit ? 255 : 0
        rgba.set([value, value, value, 255], (y * width + x) * 4)
      }
    }
  } else {
    throw new Error(`Неизвестный формат изображения PDF (${kind}).`)
  }
  return rgba
}

function light(rgba: Uint8Array, pixel: number): boolean {
  const offset = pixel * 4
  return (
    rgba[offset + 3]! > 0 &&
    rgba[offset]! >= WHITE &&
    rgba[offset + 1]! >= WHITE &&
    rgba[offset + 2]! >= WHITE
  )
}

/** Белые пиксели, связанные с краем изображения: поле вокруг знака. */
function outsideMask(rgba: Uint8Array, width: number, height: number): Uint8Array {
  const outside = new Uint8Array(width * height)
  const stack: number[] = []
  const push = (pixel: number) => {
    if (!outside[pixel] && light(rgba, pixel)) {
      outside[pixel] = 1
      stack.push(pixel)
    }
  }
  for (let x = 0; x < width; x++) {
    push(x)
    push((height - 1) * width + x)
  }
  for (let y = 0; y < height; y++) {
    push(y * width)
    push(y * width + width - 1)
  }
  while (stack.length) {
    const pixel = stack.pop()!
    const x = pixel % width
    if (x > 0) push(pixel - 1)
    if (x < width - 1) push(pixel + 1)
    if (pixel >= width) push(pixel - width)
    if (pixel < width * (height - 1)) push(pixel + width)
  }
  return outside
}

function encode(rgba: Uint8Array, width: number, height: number): Buffer {
  const png = new PNG({ width, height })
  png.data = Buffer.from(rgba)
  return PNG.sync.write(png, { colorType: 6 })
}

/** Изображение знака с прозрачным полем вокруг: так же, как изображения прежнего архива. */
function transparentOutside(rgba: Uint8Array, width: number, height: number): Uint8Array {
  const outside = outsideMask(rgba, width, height)
  const result = Uint8Array.from(rgba)
  for (let pixel = 0; pixel < outside.length; pixel++) if (outside[pixel]) result[pixel * 4 + 3] = 0
  return result
}

type Raster = { rgba: Uint8Array; width: number; height: number }

/** Промежутки непрозрачных строк или столбцов, разделённые прозрачной полосой. */
function bands(filled: (index: number) => boolean, length: number): Array<[number, number]> {
  const result: Array<[number, number]> = []
  let start = -1
  let gap = 0
  for (let index = 0; index <= length; index++) {
    const busy = index < length && filled(index)
    if (busy) {
      if (start < 0) start = index
      gap = 0
    } else if (start >= 0 && (++gap >= 3 || index === length)) {
      result.push([start, index - gap + 1])
      start = -1
      gap = 0
    }
  }
  return result.filter(([from, to]) => to - from >= 6)
}

function crop(image: Raster, x0: number, y0: number, x1: number, y1: number): Raster {
  const pad = 2
  const width = x1 - x0 + pad * 2
  const height = y1 - y0 + pad * 2
  const rgba = new Uint8Array(width * height * 4)
  for (let y = y0; y < y1; y++) {
    const row = image.rgba.subarray((y * image.width + x0) * 4, (y * image.width + x1) * 4)
    rgba.set(row, ((y - y0 + pad) * width + pad) * 4)
  }
  return { rgba, width, height }
}

/**
 * Одно изображение PDF может содержать несколько разновидностей знака, разделённых пустым
 * полем (например, три длины знака 1.34.1). Такие изображения делятся на части: сначала по
 * пустым строкам, затем каждая полоса — по пустым столбцам. Порядок — сверху вниз, слева направо.
 */
export function splitParts(image: Raster): Raster[] {
  const { rgba, width, height } = image
  const opaque = (x: number, y: number) => rgba[(y * width + x) * 4 + 3]! > 0
  const parts: Raster[] = []
  for (const [y0, y1] of bands((y) => {
    for (let x = 0; x < width; x++) if (opaque(x, y)) return true
    return false
  }, height)) {
    for (const [x0, x1] of bands((x) => {
      for (let y = y0; y < y1; y++) if (opaque(x, y)) return true
      return false
    }, width))
      parts.push({ x0, x1, y0, y1 } as never)
  }
  if (parts.length <= 1) return [image]
  return (parts as unknown as Array<{ x0: number; x1: number; y0: number; y1: number }>).map(
    (box) => {
      // Строки части ограничиваются её столбцами.
      let top = box.y1
      let bottom = box.y0
      for (let y = box.y0; y < box.y1; y++)
        for (let x = box.x0; x < box.x1; x++)
          if (opaque(x, y)) {
            top = Math.min(top, y)
            bottom = Math.max(bottom, y + 1)
          }
      return crop(image, box.x0, top, box.x1, bottom)
    },
  )
}

function pngOf(image: Raster): Buffer {
  return encode(image.rgba, image.width, image.height)
}

/**
 * Вариант знака с жёлтым фоном: белый фон внутри знака (не связанный с краем изображения)
 * окрашивается в жёлтый; переходные светлые пиксели по краю фона — пропорционально.
 */
export function yellowVariant(png: Buffer): Buffer {
  const image = PNG.sync.read(png)
  const { width, height } = image
  const rgba = new Uint8Array(image.data)
  const background = new Uint8Array(width * height)
  const outside = outsideMask(rgba, width, height)
  for (let pixel = 0; pixel < background.length; pixel++) {
    background[pixel] = !outside[pixel] && light(rgba, pixel) ? 1 : 0
  }
  // Внутренний фон — самая большая связная белая область внутри знака: белые символы и
  // надписи (цифры на синем, окантовка) не меняются.
  const component = new Int32Array(width * height).fill(-1)
  const sizes: number[] = []
  for (let start = 0; start < background.length; start++) {
    if (!background[start] || component[start] !== -1) continue
    const id = sizes.length
    let size = 0
    const stack = [start]
    component[start] = id
    while (stack.length) {
      const pixel = stack.pop()!
      size++
      const x = pixel % width
      for (const next of [
        x > 0 ? pixel - 1 : -1,
        x < width - 1 ? pixel + 1 : -1,
        pixel - width,
        pixel + width,
      ]) {
        if (next >= 0 && next < background.length && background[next] && component[next] === -1) {
          component[next] = id
          stack.push(next)
        }
      }
    }
    sizes.push(size)
  }
  if (!sizes.length) return png
  const largest = sizes.indexOf(Math.max(...sizes))
  const fill = (pixel: number) => {
    const offset = pixel * 4
    for (let channel = 0; channel < 3; channel++) {
      // Умножение на жёлтый: белый становится жёлтым, тёмные пиксели почти не меняются.
      rgba[offset + channel] = Math.round((rgba[offset + channel]! * YELLOW[channel]!) / 255)
    }
  }
  for (let pixel = 0; pixel < component.length; pixel++) {
    if (component[pixel] === largest) {
      fill(pixel)
      continue
    }
    // Сглаженные пиксели на границе фона.
    if (background[pixel] || outside[pixel]) continue
    const x = pixel % width
    const near = [
      x > 0 ? pixel - 1 : -1,
      x < width - 1 ? pixel + 1 : -1,
      pixel - width,
      pixel + width,
    ]
    const offset = pixel * 4
    if (
      near.some((next) => next >= 0 && next < component.length && component[next] === largest) &&
      Math.min(rgba[offset]!, rgba[offset + 1]!, rgba[offset + 2]!) >= 160
    )
      fill(pixel)
  }
  return encode(rgba, width, height)
}

async function pageText(page: {
  getTextContent: () => Promise<{ items: unknown[] }>
}): Promise<TextItem[]> {
  const content = await page.getTextContent()
  return content.items.flatMap((item) => {
    const text = item as { str?: string; transform?: number[]; width?: number }
    if (typeof text.str !== 'string' || !text.transform) return []
    return [{ str: text.str, x: text.transform[4]!, y: text.transform[5]!, width: text.width ?? 0 }]
  })
}

function labelsOf(page: number, items: readonly TextItem[]): Label[] {
  const labels: Label[] = []
  items.forEach((item, index) => {
    const match = LABEL.exec(item.str.trim())
    if (!match) return
    const next = items[index + 1]
    const starred =
      Boolean(match[2]) ||
      Boolean(next && next.str.trim() === '<*>' && Math.abs(next.y - item.y) < 2)
    labels.push({
      page,
      code: match[1]!,
      example: starred,
      cx: item.x + item.width / 2,
      y: item.y,
    })
  })
  return labels
}

/** Следующий номер ниже изображения в той же колонке (на этой или следующей странице). */
function labelFor(image: Placed, labels: readonly Label[]): Label | null {
  const within = (label: Label) => label.cx >= image.box.x0 - 4 && label.cx <= image.box.x1 + 4
  const below = labels
    .filter((label) => label.page === image.page && label.y < image.box.y0 + 2 && within(label))
    .sort((a, b) => b.y - a.y)[0]
  if (below) return below
  // Строка таблицы разорвана страницей: номер напечатан вверху следующей страницы.
  return (
    labels
      .filter((label) => label.page === image.page + 1 && within(label))
      .sort((a, b) => b.y - a.y)[0] ?? null
  )
}

/** Извлекает изображения знаков приложения А и перечень знаков с жёлтым фоном. */
export async function extractPdfSigns(pdf: Uint8Array): Promise<PdfSignExtraction> {
  const { getDocument, OPS } = await loadPdfJs()
  const task = getDocument({
    data: Uint8Array.from(pdf),
    isOffscreenCanvasSupported: false,
    isImageDecoderSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    stopAtErrors: false,
    verbosity: 0,
  })
  const document = await task.promise
  try {
    let first: number | null = null
    let last: number | null = null
    let fullText = ''
    const placed: Placed[] = []
    const labels: Label[] = []
    const pages = new Map<number, Awaited<ReturnType<typeof document.getPage>>>()
    for (let number = 1; number <= document.numPages; number++) {
      const page = await document.getPage(number)
      const items = await pageText(page)
      if (first === null) fullText += `${items.map((item) => item.str).join(' ')}\n`
      const start = items.find((item) => /^\s*Таблица\s+А\.1\b/u.test(item.str))
      if (first === null && start) first = number
      if (first === null) {
        page.cleanup()
        continue
      }
      const end = items.find((item) => /^\s*Приложение\s+Б\s*$/u.test(item.str))
      const endY = end ? end.y : -Infinity
      if (end && number > first) {
        // Изображения выше заголовка приложения Б ещё относятся к таблицам.
        last = number
      }
      const pageLabels = labelsOf(number, items).filter((label) => label.y > endY)
      labels.push(...pageLabels)
      const operators = await page.getOperatorList()
      let matrix: Matrix = [1, 0, 0, 1, 0, 0]
      const saved: Matrix[] = []
      let index = 0
      for (let op = 0; op < operators.fnArray.length; op++) {
        const fn = operators.fnArray[op]
        const args = operators.argsArray[op] as unknown[]
        if (fn === OPS.save) saved.push(matrix)
        else if (fn === OPS.restore) matrix = saved.pop() ?? matrix
        else if (fn === OPS.transform) matrix = multiply(matrix, args as Matrix)
        else if (fn === OPS.paintImageXObject) {
          const box = unitBox(matrix)
          // Мелкие изображения (линии, точки) не являются знаками.
          if (box.y0 > endY && box.x1 - box.x0 >= 8 && box.y1 - box.y0 >= 8)
            placed.push({ page: number, index: index++, objectId: String(args[0]), box })
        }
      }
      pages.set(number, page)
      if (placed.length > PDF_SIGN_LIMITS.maxImages)
        throw new Error('В PDF слишком много изображений для каталога знаков.')
      if (last !== null) break
    }
    const yellow = findYellowRule(fullText)
    if (first === null) return { pages: null, images: [], yellow }
    const images: PdfSignImage[] = []
    for (const item of placed) {
      const page = pages.get(item.page)!
      const store = item.objectId.startsWith('g_') ? page.commonObjs : page.objs
      const data = (await new Promise((resolve) => store.get(item.objectId, resolve))) as {
        width: number
        height: number
        kind: number
        data?: Uint8Array | Uint8ClampedArray
      } | null
      if (!data?.data || !data.width || !data.height) continue
      if (data.width > PDF_SIGN_LIMITS.maxSide || data.height > PDF_SIGN_LIMITS.maxSide) continue
      const label = labelFor(item, labels)
      const whole = {
        rgba: transparentOutside(
          toRgba(data as Parameters<typeof toRgba>[0]),
          data.width,
          data.height,
        ),
        width: data.width,
        height: data.height,
      }
      const parts = splitParts(whole)
      parts.forEach((part, index) => {
        const png = pngOf(part)
        images.push({
          key: `${item.page}-${item.index + 1}${parts.length > 1 ? `.${index + 1}` : ''}`,
          page: item.page,
          code: label?.code ?? null,
          example: label?.example ?? false,
          png,
          width: part.width,
          height: part.height,
          sha256: createHash('sha256').update(png).digest('hex'),
        })
      })
    }
    for (const page of pages.values()) page.cleanup()
    return { pages: { first, last: last ?? document.numPages }, images, yellow }
  } finally {
    await task.destroy()
  }
}

/** Решение составителя по изображению: другой номер или исключение (null). */
export type SignOverrides = Readonly<Record<string, string | null>>

export type PdfSignAssignment = {
  key: string
  /** Итоговый код в каталоге или null, если изображение не попадает в каталог. */
  code: string | null
  reason: 'detected' | 'override' | 'excluded' | 'no-label'
}

/**
 * Коды каталога по результатам извлечения: номер под изображением или исправленный
 * составителем; второе и следующие изображения того же номера получают «_v2», «_v3».
 */
export function assignSignCodes(
  extraction: PdfSignExtraction,
  overrides: SignOverrides = {},
  /** SHA-256 исходного PDF: записывается как источник изображений. */
  sourceSha256 = '',
): { assignments: PdfSignAssignment[]; entries: SignImport[]; yellow: string[] } {
  const counts = new Map<string, number>()
  const assignments: PdfSignAssignment[] = []
  const base = new Map<string, PdfSignImage>()
  const entries: SignImport[] = []
  const add = (code: string, png: Buffer, image: { width: number; height: number }) => {
    const sha256 = createHash('sha256').update(png).digest('hex')
    entries.push({
      code,
      numberedPng: png,
      plainPng: png,
      width: image.width,
      height: image.height,
      numberedSha256: sha256,
      plainSha256: sha256,
      zipSha256: sourceSha256,
    })
  }
  for (const image of extraction.images) {
    const override = Object.hasOwn(overrides, image.key) ? overrides[image.key] : undefined
    const number = override === undefined ? image.code : override
    if (!number) {
      assignments.push({
        key: image.key,
        code: null,
        reason: override === null ? 'excluded' : 'no-label',
      })
      continue
    }
    const count = (counts.get(number) ?? 0) + 1
    counts.set(number, count)
    const code = count === 1 ? number : `${number}_v${count}`
    if (count === 1) base.set(number, image)
    assignments.push({
      key: image.key,
      code,
      reason: override === undefined ? 'detected' : 'override',
    })
    add(code, image.png, image)
  }
  const yellow = [...yellowCodes(extraction.yellow, [...base.keys()])].sort(compareSignCodes)
  for (const code of yellow) {
    const image = base.get(code)!
    add(`${code}_ж`, yellowVariant(image.png), image)
  }
  entries.sort((a, b) => compareSignCodes(a.code, b.code))
  return { assignments, entries, yellow }
}
