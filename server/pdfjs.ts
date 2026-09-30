type PdfJs = typeof import('pdfjs-dist/legacy/build/pdf.mjs')
let pdfjs: Promise<PdfJs> | null = null

/**
 * pdf.js загружается только при разборе PDF. В Node.js он работает без отдельного потока:
 * обработчик подключается явно, чтобы попасть и в сборку исполняемого файла. Предупреждения
 * об отсутствии необязательного модуля отрисовки не нужны: страницы не рисуются.
 */
export function loadPdfJs(): Promise<PdfJs> {
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
