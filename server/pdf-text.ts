import { loadPdfJs } from './pdfjs.ts'

type Item = { str: string; x: number; y: number; width: number; height: number }

/**
 * Текст PDF по страницам: фрагменты одной строки (близкая базовая линия) собираются слева
 * направо, строки — сверху вниз. Отсканированные страницы без текстового слоя дают пустую
 * строку.
 */
export async function extractPdfText(pdf: Uint8Array, maxPages = Infinity): Promise<string[]> {
  const { getDocument } = await loadPdfJs()
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
    const pages: string[] = []
    for (let number = 1; number <= Math.min(document.numPages, maxPages); number++) {
      const page = await document.getPage(number)
      const content = await page.getTextContent()
      const items: Item[] = content.items.flatMap((raw) => {
        const item = raw as { str?: string; transform?: number[]; width?: number; height?: number }
        if (typeof item.str !== 'string' || !item.transform || !item.str.trim()) return []
        return [
          {
            str: item.str,
            x: item.transform[4]!,
            y: item.transform[5]!,
            width: item.width ?? 0,
            height: Math.abs(item.height ?? item.transform[3] ?? 10) || 10,
          },
        ]
      })
      items.sort((a, b) => b.y - a.y || a.x - b.x)
      const lines: Item[][] = []
      for (const item of items) {
        const line = lines.at(-1)
        if (line && Math.abs(line[0]!.y - item.y) <= Math.min(line[0]!.height, item.height) * 0.5)
          line.push(item)
        else lines.push([item])
      }
      pages.push(
        lines
          .map((line) => {
            line.sort((a, b) => a.x - b.x)
            let text = ''
            let end = -Infinity
            for (const item of line) {
              // Пробел между фрагментами, если между ними есть промежуток.
              if (text && item.x - end > 1 && !text.endsWith(' ') && !item.str.startsWith(' '))
                text += ' '
              text += item.str
              end = item.x + item.width
            }
            return text.replace(/\s+/g, ' ').trim()
          })
          .join('\n'),
      )
      page.cleanup()
    }
    return pages
  } finally {
    await task.destroy()
  }
}
