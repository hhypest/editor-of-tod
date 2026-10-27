import { readdirSync, readFileSync } from 'node:fs'
import { posix } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'
import { parse as parseSfc } from '@vue/compiler-sfc'
import { externalImportRules, localImportRules, moduleLayers } from './architecture-policy.ts'

const moduleExtensions = ['.ts', '.tsx', '.mts', '.vue', '.mjs']
const isModule = (path: string) => moduleExtensions.some((extension) => path.endsWith(extension))

function scriptsIn(path: string, text: string, problems: string[]): ts.SourceFile[] {
  if (!path.endsWith('.vue')) return [ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)]
  const { descriptor, errors } = parseSfc(text, {
    filename: path,
    sourceMap: false,
    ignoreEmpty: false,
  })
  for (const error of errors) {
    const location =
      'loc' in error && error.loc ? ` at ${error.loc.start.line}:${error.loc.start.column}` : ''
    problems.push(`${path}: invalid Vue SFC${location}: ${error.message}`)
  }
  const scripts: ts.SourceFile[] = []
  for (const block of [descriptor.script, descriptor.scriptSetup]) {
    if (!block) continue
    if (block.lang && !['js', 'jsx', 'ts', 'tsx'].includes(block.lang))
      problems.push(`${path}: unsupported Vue script language ${block.lang}`)
    const kind = block.lang === 'tsx' || block.lang === 'jsx' ? ts.ScriptKind.TSX : ts.ScriptKind.TS
    scripts.push(ts.createSourceFile(path, block.content, ts.ScriptTarget.Latest, true, kind))
    // An external script is an import edge even though the SFC block has no inline content.
    if (block.src)
      scripts.push(
        ts.createSourceFile(
          path,
          `import ${JSON.stringify(block.src)}`,
          ts.ScriptTarget.Latest,
          true,
        ),
      )
  }
  return scripts
}

function resolveLocal(sources: ReadonlyMap<string, string>, path: string, specifier: string) {
  const clean = specifier.split(/[?#]/)[0]!
  const base = posix.normalize(
    clean.startsWith('@/') ? `src/${clean.slice(2)}` : posix.join(posix.dirname(path), clean),
  )
  const target = [
    base,
    ...moduleExtensions.map((extension) => `${base}${extension}`),
    ...moduleExtensions.map((extension) => `${base}/index${extension}`),
  ].find((candidate) => sources.has(candidate))
  return { target, base }
}

/** Analyze resolved local imports, including type imports, re-exports and literal import(). */
export function architectureProblems(sources: ReadonlyMap<string, string>): string[] {
  const problems: string[] = []
  const graph = new Map<string, string[]>()
  for (const [path, text] of sources) {
    const edges = new Set<string>()
    const visit = (node: ts.Node): void => {
      let specifier: string | undefined
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      )
        specifier = node.moduleSpecifier.text
      if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments[0] &&
        (ts.isStringLiteral(node.arguments[0]) ||
          ts.isNoSubstitutionTemplateLiteral(node.arguments[0]))
      )
        specifier = node.arguments[0].text
      else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword)
        problems.push(`${path}: non-static dynamic import cannot be checked`)
      if (
        ts.isImportTypeNode(node) &&
        ts.isLiteralTypeNode(node.argument) &&
        ts.isStringLiteral(node.argument.literal)
      )
        specifier = node.argument.literal.text
      for (const rule of externalImportRules)
        if (
          specifier &&
          moduleLayers[rule.from].test(path) &&
          rule.specifier.test(specifier.split(/[?#]/)[0]!)
        )
          problems.push(`${path}: ${rule.message} ${specifier}`)
      if (specifier?.startsWith('.') || specifier?.startsWith('@/')) {
        const { target, base } = resolveLocal(sources, path, specifier)
        // Raw text assets (licenses, etc.) have no module dependency graph.
        if (!target && /[?&]raw(?:[&#]|$)/.test(specifier) && !isModule(base)) return
        if (!target) problems.push(`${path}: unresolved local import ${specifier}`)
        else {
          edges.add(target)
          for (const rule of localImportRules)
            if (moduleLayers[rule.from].test(path) && moduleLayers[rule.to].test(target))
              problems.push(`${path}: ${rule.message}${rule.includeTarget ? ` ${target}` : ''}`)
        }
      }
      ts.forEachChild(node, visit)
    }
    for (const ast of scriptsIn(path, text, problems)) visit(ast)
    graph.set(path, [...edges].sort())
  }
  const visited = new Set<string>()
  const active: string[] = []
  const visit = (path: string): void => {
    const cycleStart = active.indexOf(path)
    if (cycleStart >= 0) {
      problems.push(`Import cycle: ${[...active.slice(cycleStart), path].join(' -> ')}`)
      return
    }
    if (visited.has(path)) return
    active.push(path)
    for (const target of graph.get(path) ?? []) visit(target)
    active.pop()
    visited.add(path)
  }
  for (const path of [...graph.keys()].sort()) visit(path)
  return problems.sort()
}

export function readArchitectureSources(root: string): Map<string, string> {
  const sources = new Map<string, string>()
  const walk = (directory: string): void => {
    for (const entry of readdirSync(`${root}/${directory}`, { withFileTypes: true })) {
      const path = `${directory}/${entry.name}`
      if (entry.isDirectory() && entry.name !== '__tests__') walk(path)
      else if (entry.isFile() && isModule(path) && !/\.d\.(?:ts|mts)$/.test(path))
        sources.set(path, readFileSync(`${root}/${path}`, 'utf8'))
    }
  }
  walk('src')
  walk('server')
  return sources
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const sources = readArchitectureSources(fileURLToPath(new URL('..', import.meta.url)))
  const problems = architectureProblems(sources)
  if (problems.length) {
    console.error(problems.join('\n'))
    process.exitCode = 1
  } else console.log(`Architectural boundaries and import cycles: ${sources.size} modules checked.`)
}
