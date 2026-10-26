import { createHash } from 'node:crypto'
import { PNG } from 'pngjs'
import type { SignImport } from '../signs'
import type { SignCatalogSource } from '../signs/catalog-repository'

const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')
export function catalogEntry(code = '9.99', marker = 100, width = 8, height = 6): SignImport {
  const plain = new PNG({ width, height }),
    numbered = new PNG({ width: width + 3, height })
  plain.data.fill(marker)
  numbered.data.fill(marker + 1)
  const plainPng = PNG.sync.write(plain),
    numberedPng = PNG.sync.write(numbered)
  return {
    code,
    plainPng,
    numberedPng,
    width,
    height,
    plainSha256: sha(plainPng),
    numberedSha256: sha(numberedPng),
    zipSha256: sha(`fictional-archive-${marker}`),
  }
}
export const catalogSource = (partial: Partial<SignCatalogSource> = {}): SignCatalogSource => ({
  documentCode: 'FICTIONAL SIGNS',
  edition: '2030',
  pdfSha256: null,
  documentId: null,
  ...partial,
})
