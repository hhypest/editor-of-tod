import { execFileSync } from 'node:child_process'
import { lstatSync, readFileSync } from 'node:fs'
import { posix, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export type DocumentationProblem = { path: string; line: number; rule: string; message: string }
type Link = { line: number; href: string }

/** GitHub-style heading anchors, including repeated headings; fenced examples are ignored. */
export function markdownInfo(source: string): {
  anchors: Set<string>
  links: Link[]
  text: string
} {
  const anchors = new Set<string>()
  const counts = new Map<string, number>()
  const links: Link[] = []
  const definitions = new Map<string, string>()
  const references: { line: number; key: string }[] = []
  const visible: string[] = []
  let fence: { character: string; length: number } | null = null
  for (const [index, line] of source.split('\n').entries()) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1]
    if (marker) {
      if (!fence) fence = { character: marker[0]!, length: marker.length }
      else if (
        marker[0] === fence.character &&
        marker.length >= fence.length &&
        /^\s{0,3}(?:`{3,}|~{3,})\s*$/.test(line)
      )
        fence = null
      continue
    }
    if (fence) continue
    visible.push(line)
    const heading = /^#{1,6}\s+(.+?)(?:\s+#+)?\s*$/.exec(line)?.[1]
    if (heading) {
      const slug = heading
        .replace(/`([^`]+)`/g, '$1')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, '')
        .replace(/ /g, '-')
      let anchor = slug
      let suffix = counts.get(slug) ?? 0
      while (anchors.has(anchor)) anchor = `${slug}-${++suffix}`
      anchors.add(anchor)
      counts.set(slug, suffix)
    }
    for (const match of line.matchAll(/<a\s+(?:id|name)=["']([^"']+)["']/gi)) anchors.add(match[1]!)
    const definition = /^\s{0,3}\[([^\]]+)\]:\s*<?([^\s>]+)>?/.exec(line)
    if (definition) definitions.set(definition[1]!.toLowerCase(), definition[2]!)
    for (const match of line.matchAll(
      /\[[^\]]*\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+["'][^"']*["'])?\s*\)/g,
    ))
      links.push({ line: index + 1, href: match[1] ?? match[2]! })
    for (const match of line.matchAll(/\[([^\]]+)\]\[([^\]]*)\]/g))
      references.push({ line: index + 1, key: (match[2] || match[1]!).toLowerCase() })
  }
  for (const ref of references)
    links.push({ line: ref.line, href: definitions.get(ref.key) ?? `missing-reference:${ref.key}` })
  return { anchors, links, text: visible.join('\n') }
}

export function documentationProblems(
  sources: ReadonlyMap<string, string>,
  repositoryPaths: ReadonlySet<string> = new Set(sources.keys()),
): DocumentationProblem[] {
  const problems: DocumentationProblem[] = []
  const add = (path: string, line: number, rule: string, message: string) =>
    problems.push({ path, line, rule, message })
  const paths = new Set(repositoryPaths)
  for (const file of repositoryPaths) {
    let dir = posix.dirname(file)
    while (dir !== '.' && dir !== '/') {
      paths.add(dir)
      dir = posix.dirname(dir)
    }
  }
  const docs = new Map(
    [...sources].filter(([p]) => /\.md$/i.test(p)).map(([p, s]) => [p, markdownInfo(s)]),
  )
  const catalogued = new Set<string>()
  const scripts = Object.keys(
    (JSON.parse(sources.get('package.json') ?? '{"scripts":{}}') as { scripts: object }).scripts,
  )
  for (const [file, info] of docs) {
    const source = sources.get(file)!
    const preamble = info.text.split('\n## ')[0]!
    const historical =
      file.startsWith('docs/archive/') ||
      file.startsWith('docs/adr/') ||
      file.startsWith('docs/verification/reports/')
    for (const link of info.links) {
      if (link.href.startsWith('missing-reference:')) {
        add(file, link.line, 'reference', `Undefined reference ${link.href.slice(18)}`)
        continue
      }
      if (/^(?:[a-z][a-z\d+.-]*:|\/\/|\/)/i.test(link.href)) continue
      const [name, fragment] = link.href.split('#')
      let target: string
      let anchor: string | undefined
      try {
        target = name
          ? posix.normalize(
              posix.join(posix.dirname(file), decodeURIComponent(name.split('?')[0]!)),
            )
          : file
        target = target.replace(/\/$/, '')
        anchor = fragment === undefined ? undefined : decodeURIComponent(fragment)
      } catch {
        add(file, link.line, 'link', `Invalid URL encoding: ${link.href}`)
        continue
      }
      if (!paths.has(target)) add(file, link.line, 'link', `Missing target: ${target}`)
      else if (anchor && docs.has(target) && !docs.get(target)!.anchors.has(anchor))
        add(file, link.line, 'anchor', `Missing anchor: ${target}#${anchor}`)
      if (
        file === 'docs/catalog.md' &&
        link.line <= source.split('## Карта прежних путей')[0]!.split('\n').length &&
        source.split('\n')[link.line - 1]?.startsWith('|')
      )
        catalogued.add(target)
    }
    if (file.startsWith('docs/archive/')) {
      if (
        !/^> \*\*(?:Исторический материал|Архив исходного документа)\./m.test(preamble) ||
        !/\b\d{2}\.\d{2}\.\d{4}\b/.test(preamble) ||
        !/\/blob\/[a-f\d]{40}\//.test(preamble)
      )
        add(file, 1, 'provenance', 'Archive must name a date and an exact source commit')
    } else if (file.startsWith('docs/adr/') && !file.endsWith('/README.md')) {
      if (!/статус:/i.test(preamble)) add(file, 1, 'status', 'ADR must declare its status')
    } else if (
      (file.startsWith('docs/') || file === 'TESTING.MD') &&
      !/^Тип:\s*(?:действующ|план|согласован|пример|протокол|реестр|навигатор|страница|стабильн)/im.test(
        preamble,
      )
    ) {
      add(file, 1, 'type', 'Declare the document type/status near its beginning')
    }
    if (historical) continue
    for (const [index, line] of source.split('\n').entries()) {
      for (const command of line.matchAll(/\bnpm run ([a-z\d][a-z\d:_-]*)/g))
        if (!scripts.includes(command[1]!))
          add(file, index + 1, 'command', `Unknown package.json script: ${command[1]}`)
      for (const code of line.matchAll(
        /`((?:src|server|scripts|tests|\.github)\/[A-Za-z\d_./-]+\.(?:ts|vue|mjs|yml|json))`/g,
      ))
        // This retired name is deliberately retained in already stored diagnostic frames.
        if (
          !paths.has(code[1]!) &&
          !(file === 'docs/engineering/diagnostics.md' && code[1] === 'server/store.ts')
        )
          add(file, index + 1, 'code-path', `Missing current code path: ${code[1]}`)
    }
  }
  for (const file of docs.keys())
    if (!catalogued.has(file))
      add('docs/catalog.md', 1, 'catalog', `Uncatalogued document: ${file}`)
  const count = /Каталог охватывает (\d+) Markdown/.exec(sources.get('docs/catalog.md') ?? '')?.[1]
  if (count !== String(docs.size))
    add(
      'docs/catalog.md',
      1,
      'count',
      `Expected ${docs.size} Markdown documents, stated ${count ?? 'none'}`,
    )
  for (const file of ['.github/workflows/ci.yml', '.github/workflows/windows-exe.yml']) {
    const workflow = sources.get(file)
    if (!workflow) continue
    const installs = [...workflow.matchAll(/npx playwright install[^\n]*/g)]
    if (
      !installs.length ||
      installs.some(([line]) => !/\bchromium\b/.test(line) || !/\bfirefox\b/.test(line))
    )
      add(file, 1, 'browsers', 'The full E2E workflow must install Chromium and Firefox')
  }
  return problems
}

export function readDocumentationSources(root: string): {
  sources: Map<string, string>
  paths: Set<string>
} {
  const listed = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { cwd: root, encoding: 'utf8' },
  )
  const paths = new Set<string>()
  const sources = new Map<string, string>()
  for (const file of new Set(listed.split('\0').filter(Boolean))) {
    const absolute = resolve(root, file)
    try {
      if (!lstatSync(absolute).isFile()) continue
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    paths.add(file)
    if (
      /\.md$/i.test(file) ||
      file === 'package.json' ||
      /^\.github\/workflows\/(?:ci|windows-exe)\.yml$/.test(file)
    )
      sources.set(file, readFileSync(absolute, 'utf8'))
  }
  return { sources, paths }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { sources, paths } = readDocumentationSources(fileURLToPath(new URL('..', import.meta.url)))
  const problems = documentationProblems(sources, paths)
  if (process.argv.includes('--json'))
    console.log(
      JSON.stringify(
        { documents: [...sources.keys()].filter((p) => /\.md$/i.test(p)).length, problems },
        null,
        2,
      ),
    )
  else if (problems.length)
    console.error(problems.map((p) => `${p.path}:${p.line} [${p.rule}] ${p.message}`).join('\n'))
  else
    console.log(
      `Documentation: ${[...sources.keys()].filter((p) => /\.md$/i.test(p)).length} documents; links, catalog, status, commands and browser setup checked.`,
    )
  if (problems.length) process.exitCode = 1
}
