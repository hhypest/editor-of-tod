/**
 * Растровая копия листа. SVG, загруженный как изображение, не может сам подгрузить PNG знаков,
 * поэтому перед отрисовкой они встраиваются как data URL. Шрифты берутся из системы.
 */
export const PNG_SCALE = 2.1 // около 300 dpi для A4: 1680 × 2,1 ≈ 3528 точек по ширине

async function asDataUrl(url: string): Promise<string> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Не удалось загрузить изображение знака (${response.status}).`)
  const blob = await response.blob()
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('Не удалось прочитать изображение знака.'))
    reader.readAsDataURL(blob)
  })
}

export async function sheetToPng(
  svg: SVGSVGElement,
  width: number,
  height: number,
  scale = PNG_SCALE,
): Promise<Blob> {
  const clone = svg.cloneNode(true) as SVGSVGElement
  clone.removeAttribute('style')
  clone.setAttribute('width', String(Math.round(width * scale)))
  clone.setAttribute('height', String(Math.round(height * scale)))
  const cache = new Map<string, Promise<string>>()
  await Promise.all(
    [...clone.querySelectorAll('image')].map(async (image) => {
      const href = image.getAttribute('href')
      if (!href || href.startsWith('data:')) return
      if (!cache.has(href)) cache.set(href, asDataUrl(href))
      image.setAttribute('href', await cache.get(href)!)
    }),
  )
  const markup = new XMLSerializer().serializeToString(clone)
  const url = URL.createObjectURL(new Blob([markup], { type: 'image/svg+xml;charset=utf-8' }))
  try {
    const picture = new Image()
    picture.src = url
    await picture.decode()
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(width * scale)
    canvas.height = Math.round(height * scale)
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Браузер не поддерживает отрисовку PNG.')
    context.fillStyle = '#fff'
    context.fillRect(0, 0, canvas.width, canvas.height)
    context.drawImage(picture, 0, 0, canvas.width, canvas.height)
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('Не удалось сформировать PNG.'))),
        'image/png',
      ),
    )
  } finally {
    URL.revokeObjectURL(url)
  }
}

/** Имя файла без символов, недопустимых в Windows. */
export function sheetFileName(parts: readonly string[], extension: string): string {
  const base = parts
    .map((part) => part.trim())
    .filter(Boolean)
    .join('_')
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, '_')
    .slice(0, 120)
  return `${base || 'Схема'}.${extension}`
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
