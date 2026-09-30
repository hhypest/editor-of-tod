// Сведения о сторонних компонентах, которые входят в программу: интерфейс (из сборки Vite),
// локальный сервер (из сборки esbuild) и среда Node.js в исполняемом файле. Лицензии MIT, ISC,
// BSD и Apache-2.0 требуют сохранять уведомление об авторском праве и текст лицензии в копиях
// программы, поэтому при сборке формируется THIRD_PARTY_LICENSES.txt с полными текстами.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { build } from 'esbuild'

/** Лицензии, совместимые с распространением программы по MIT без дополнительных условий. */
export const ALLOWED_LICENSES = new Set([
  'MIT',
  'MIT/X11',
  'ISC',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'Apache-2.0',
  'Unlicense',
  '0BSD',
  'Zlib',
  'CC0-1.0',
  'BlueOak-1.0.0',
])

/**
 * Пакеты без поля license и без файла лицензии: условие указано здесь явно, с источником.
 * Пополняется только после проверки репозитория пакета.
 */
export const LICENSE_OVERRIDES: Readonly<Record<string, { license: string; note: string }>> = {
  buffers: {
    license: 'MIT/X11',
    note: 'В package.json версии 0.1.1 лицензия не указана; README исходного репозитория substack/node-buffers (сохранённая копия: github.com/franchb/node-buffers-substack-orig) указывает MIT/X11.',
  },
}

export type PackageInfo = {
  name: string
  version: string
  declared: string | null
  license: string | null
  author: string | null
  homepage: string | null
  note: string | null
  texts: Array<{ file: string; text: string }>
}

export type NoticeGroup = { title: string; packages: PackageInfo[] }
export type NodeNotice = { version: string; text: string | null }

type PackageJson = {
  name: string
  version: string
  license?: string | { type?: string }
  licenses?: Array<{ type?: string } | string>
  author?: string | { name?: string; email?: string }
  homepage?: string
  repository?: string | { url?: string }
}

const MIT_TEXT = `Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`

const ISC_TEXT = `Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.`

/**
 * Выбор лицензии из SPDX-выражения: при «A OR B» берётся первая разрешённая, при «A AND B»
 * должны быть разрешены все. Возвращает null, если выражение не проходит.
 */
export function chooseLicense(expression: string | null | undefined): string | null {
  if (typeof expression !== 'string' || !expression.trim()) return null
  const text = expression.trim().replace(/^\((.*)\)$/, '$1')
  if (/\sOR\s/.test(text)) {
    return (
      text
        .split(/\s+OR\s+/)
        .map((part) => chooseLicense(part))
        .find((part): part is string => Boolean(part)) ?? null
    )
  }
  if (/\sAND\s/.test(text)) {
    const parts = text.split(/\s+AND\s+/).map((part) => part.trim())
    return parts.every((part) => ALLOWED_LICENSES.has(part)) ? parts.join(' AND ') : null
  }
  return ALLOWED_LICENSES.has(text) ? text : null
}

/**
 * Каталог пакета по пути модуля: …/node_modules/@scope/name/… или …/node_modules/name/….
 * Для вложенных node_modules берётся самый глубокий пакет.
 */
export function packageDirectory(modulePath: string): string | null {
  const normalized = (modulePath.replace(/\0/g, '').split('?')[0] ?? '').split(sep).join('/')
  const greedy = normalized.lastIndexOf('/node_modules/')
  if (greedy < 0) return null
  const rest = normalized.slice(greedy + '/node_modules/'.length).split('/')
  const [first = '', second = ''] = rest
  if (!first || (first.startsWith('@') && !second)) return null
  const name = first.startsWith('@') ? `${first}/${second}` : first
  return `${normalized.slice(0, greedy)}/node_modules/${name}`
}

function authorName(author: PackageJson['author']): string | null {
  if (!author) return null
  if (typeof author === 'string') return author
  return [author.name, author.email && `<${author.email}>`].filter(Boolean).join(' ') || null
}

/** Сведения о пакете и тексты его лицензии и уведомлений (LICENSE*, COPYING*, NOTICE*). */
export function describePackage(directory: string): PackageInfo {
  const pkg = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as PackageJson
  const declared =
    typeof pkg.license === 'string'
      ? pkg.license
      : Array.isArray(pkg.licenses)
        ? pkg.licenses.map((item) => (typeof item === 'string' ? item : item.type)).join(' OR ')
        : (pkg.license?.type ?? null)
  const override = LICENSE_OVERRIDES[pkg.name]
  const license = chooseLicense(declared ?? override?.license)
  const files = readdirSync(directory)
    .filter((name) => /^(licen[cs]e|copying|notice)/i.test(name))
    .sort()
  const texts = files.map((file) => ({
    file,
    text: readFileSync(join(directory, file), 'utf8').replace(/\r\n/g, '\n').trim(),
  }))
  const author = authorName(pkg.author)
  // Без файла лицензии в пакете текст берётся из шаблона с автором из package.json.
  if (!texts.length && license) {
    const template = license.startsWith('ISC')
      ? ISC_TEXT
      : license.startsWith('MIT')
        ? MIT_TEXT
        : null
    if (template) {
      texts.push({
        file: `${license} (шаблон: в пакете нет файла лицензии)`,
        text: `Copyright (c) ${author ?? pkg.name + ' authors'}\n\n${template}`,
      })
    }
  }
  return {
    name: pkg.name,
    version: pkg.version,
    declared,
    license,
    author,
    homepage:
      pkg.homepage ??
      (typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url) ??
      null,
    note: override?.note ?? null,
    texts,
  }
}

/** Пакеты из списка путей модулей: одна запись на имя и версию (копии в разных node_modules). */
export function packagesFromModules(modulePaths: Iterable<string>): PackageInfo[] {
  const directories = new Set<string>()
  for (const path of modulePaths) {
    const directory = packageDirectory(path)
    if (directory && existsSync(join(directory, 'package.json'))) directories.add(directory)
  }
  const unique = new Map<string, PackageInfo>()
  for (const directory of directories) {
    const item = describePackage(directory)
    unique.set(`${item.name}@${item.version}`, item)
  }
  return [...unique.values()].sort(
    (a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version),
  )
}

/** Пакеты с неразрешённой или неизвестной лицензией — сборка должна остановиться. */
export function licenseProblems(packages: readonly PackageInfo[]): string[] {
  return packages
    .filter((item) => !item.license || !item.texts.length)
    .map(
      (item) =>
        `${item.name}@${item.version}: ${item.license ? 'нет текста лицензии' : `лицензия «${item.declared ?? 'не указана'}» не входит в разрешённые`}`,
    )
}

/** Модули серверной части из сборки esbuild той же конфигурации, что у исполняемого файла. */
export async function serverModules(root: string): Promise<string[]> {
  const result = await build({
    entryPoints: [join(root, 'server', 'desktop.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    write: false,
    metafile: true,
    logLevel: 'silent',
    outfile: join(root, 'release', '.licenses', 'app.cjs'),
  })
  return Object.keys(result.metafile.inputs).map((path) => resolve(root, path))
}

/** Текст лицензии Node.js рядом с запущенным node (установка Windows, архив Linux). */
export function nodeLicense(execPath: string = process.execPath): string | null {
  const directory = dirname(execPath)
  const candidates = [
    join(directory, 'LICENSE'),
    join(directory, '..', 'LICENSE'),
    join(directory, '..', 'share', 'doc', 'node', 'LICENSE'),
  ]
  const found = candidates.find((path) => existsSync(path))
  return found ? readFileSync(found, 'utf8').replace(/\r\n/g, '\n').trim() : null
}

const RULE = '='.repeat(78)

/** Полный текст THIRD_PARTY_LICENSES.txt. */
export function renderNotices({
  groups,
  node,
}: {
  groups: readonly NoticeGroup[]
  node: NodeNotice | null
}): string {
  const lines = [
    'СТОРОННИЕ КОМПОНЕНТЫ РЕДАКТОРА СОДД (editor-of-tod)',
    '',
    'Программа распространяется по лицензии MIT (файл LICENSE). В неё входят компоненты',
    'других авторов на перечисленных ниже условиях. Тексты лицензий приведены полностью,',
    'как того требуют эти условия. Инструменты разработки и тестирования в программу',
    'не входят и здесь не перечислены.',
    '',
  ]
  for (const group of groups) {
    lines.push(RULE, group.title, RULE, '')
    for (const item of group.packages) {
      lines.push(`${item.name} ${item.version} — ${item.license}`)
      if (item.author) lines.push(`Автор: ${item.author}`)
      if (item.homepage) lines.push(`Источник: ${item.homepage}`)
      if (item.note) lines.push(`Примечание: ${item.note}`)
      for (const text of item.texts) lines.push('', `--- ${text.file} ---`, text.text)
      lines.push('', '-'.repeat(78), '')
    }
  }
  if (node) {
    lines.push(
      RULE,
      `Среда выполнения Node.js ${node.version} (встроена в исполняемый файл)`,
      RULE,
      '',
    )
    lines.push(
      node.text ?? `Текст лицензии: https://github.com/nodejs/node/blob/v${node.version}/LICENSE`,
      '',
    )
  }
  return `${lines.join('\n').trimEnd()}\n`
}

/** Краткий список для раздела «О программе». */
export function summary(groups: readonly NoticeGroup[], node: NodeNotice | null) {
  return {
    groups: groups.map((group) => ({
      title: group.title,
      packages: group.packages.map(({ name, version, license, homepage }) => ({
        name,
        version,
        license,
        homepage,
      })),
    })),
    node: node ? { version: node.version, license: 'MIT и лицензии встроенных библиотек' } : null,
  }
}
