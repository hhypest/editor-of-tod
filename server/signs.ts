import { createHash } from 'node:crypto'
import { unzipSync } from 'fflate'
import { PNG } from 'pngjs'
import ImageTracer from 'imagetracerjs'

export type SignImport = {
  code: string
  numberedPng: Buffer
  plainPng: Buffer
  plainSvg: string | null
  width: number
  height: number
  numberedSha256: string
  plainSha256: string
  zipSha256: string
}

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function filename(name: string): string {
  if (name.startsWith('PNG с номером/') || name.startsWith('PNG без номера/')) return name
  // This archive contains UTF-8 filename bytes without the ZIP UTF-8 flag.
  const recovered = Buffer.from(name, 'latin1').toString('utf8')
  return recovered.includes('\uFFFD') ? name : recovered
}

export function parseSignArchive(source: Buffer, vectorize = false): SignImport[] {
  if (source.length > 64 * 1024 * 1024 || source.length < 100) {
    throw new Error('Нужен ZIP набора знаков размером до 64 МБ.')
  }
  let count = 0
  let total = 0
  const names = new Map<string, string>()
  const seenNames = new Set<string>()
  const unzipped = unzipSync(source, {
    filter(entry) {
      const name = filename(entry.name)
      if (name.endsWith('/')) return false
      count++
      total += entry.originalSize
      if (count > 2_000 || total > 150 * 1024 * 1024 || entry.originalSize > 1 * 1024 * 1024) {
        throw new Error('Архив знаков слишком велик после распаковки.')
      }
      if (!/^PNG (с номером|без номера)\/[0-9][0-9A-Za-z._-]*ж?\.png$/.test(name)) {
        throw new Error('Архив знаков содержит неподдерживаемое имя файла.')
      }
      if (seenNames.has(name)) throw new Error('В архиве повторяется имя изображения знака.')
      seenNames.add(name)
      names.set(entry.name, name)
      return true
    },
  })
  const pairs = new Map<string, { numbered?: Buffer; plain?: Buffer }>()
  for (const [originalName, bytes] of Object.entries(unzipped)) {
    const decoded = names.get(originalName)!
    const [folder, basename] = decoded.split('/')
    const code = basename!.slice(0, -4)
    const pair = pairs.get(code) ?? {}
    const png = Buffer.from(bytes)
    if (
      png.length < 24 ||
      !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
      png.readUInt32BE(16) > 2_048 ||
      png.readUInt32BE(20) > 2_048 ||
      !png.readUInt32BE(16) ||
      !png.readUInt32BE(20)
    ) {
      throw new Error(`Знак ${code}: недопустимые размеры PNG.`)
    }
    PNG.sync.read(png, { checkCRC: true })
    if (folder === 'PNG с номером') {
      if (pair.numbered) throw new Error(`Знак ${code}: повтор изображения с номером.`)
      pair.numbered = Buffer.from(bytes)
    } else {
      if (pair.plain) throw new Error(`Знак ${code}: повтор изображения без номера.`)
      pair.plain = Buffer.from(bytes)
    }
    pairs.set(code, pair)
  }
  if (!pairs.size) throw new Error('В архиве нет знаков PNG.')
  const zipSha256 = digest(source)
  return Array.from(pairs, ([code, pair]) => {
    if (!pair.plain || !pair.numbered) throw new Error(`Знак ${code}: нужна пара PNG.`)
    const image = PNG.sync.read(pair.plain)
    const plainSvg = vectorize
      ? ImageTracer.imagedataToSVG(
          { width: image.width, height: image.height, data: image.data },
          {
            ltres: 1,
            qtres: 1,
            pathomit: 12,
            colorsampling: 0,
            numberofcolors: 8,
            colorquantcycles: 3,
            roundcoords: 1,
            viewbox: true,
            blurradius: 1,
            blurdelta: 20,
          },
        )
      : null
    if (plainSvg && (plainSvg.length > 2_000_000 || !plainSvg.startsWith('<svg '))) {
      throw new Error(`Знак ${code}: не удалось создать безопасный SVG.`)
    }
    return {
      code,
      numberedPng: pair.numbered,
      plainPng: pair.plain,
      plainSvg,
      width: image.width,
      height: image.height,
      numberedSha256: digest(pair.numbered),
      plainSha256: digest(pair.plain),
      zipSha256,
    }
  }).sort((a, b) => a.code.localeCompare(b.code, 'ru', { numeric: true }))
}
