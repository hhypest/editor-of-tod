// Обработчик pdf.js подключается в Node.js напрямую, без отдельного потока.
declare module 'pdfjs-dist/legacy/build/pdf.worker.mjs' {
  export const WorkerMessageHandler: unknown
}
