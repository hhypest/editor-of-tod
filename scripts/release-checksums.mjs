// Контрольные суммы дистрибутива: SHA-256 каждого передаваемого файла в формате
// `sha256sum` («<hex>  <имя>»). Файл SHA256SUMS.txt передаётся вместе с программой; на
// Windows сумма файла проверяется командой PowerShell `Get-FileHash <файл>`.
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Имя файла с контрольными суммами рядом с программой. */
export const CHECKSUMS_FILE = 'SHA256SUMS.txt'

/** SHA-256 файла в шестнадцатеричном виде (строчные буквы, как у `sha256sum`). */
export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/** Строки контрольных сумм файлов каталога в порядке имён; имя без пути. */
export function checksumLines(directory, names) {
  return [...names]
    .sort()
    .map((name) => `${sha256File(join(directory, name))}  ${name}`)
    .join('\n')
    .concat('\n')
}

/** Записывает SHA256SUMS.txt в каталог и возвращает его содержимое. */
export function writeChecksums(directory, names) {
  const text = checksumLines(directory, names)
  writeFileSync(join(directory, CHECKSUMS_FILE), text)
  return text
}
