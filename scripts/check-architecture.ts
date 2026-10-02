import { readdirSync, readFileSync } from 'node:fs'
import { posix } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'

/** Analyze resolved local imports, including type imports, re-exports and literal import(). */
export function architectureProblems(sources: ReadonlyMap<string, string>): string[] {
  const problems: string[] = []
  const graph = new Map<string, string[]>()
  for (const [path, text] of sources) {
    const script = path.endsWith('.vue')
      ? [...text.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n')
      : text
    const ast = ts.createSourceFile(path, script, ts.ScriptTarget.Latest, true)
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
        ts.isStringLiteral(node.arguments[0])
      )
        specifier = node.arguments[0].text
      if (
        ts.isImportTypeNode(node) &&
        ts.isLiteralTypeNode(node.argument) &&
        ts.isStringLiteral(node.argument.literal)
      )
        specifier = node.argument.literal.text
      if (specifier?.startsWith('.') || specifier?.startsWith('@/')) {
        const clean = specifier.split('?')[0]!
        const base = posix.normalize(
          clean.startsWith('@/') ? `src/${clean.slice(2)}` : posix.join(posix.dirname(path), clean),
        )
        const target = [base, `${base}.ts`, `${base}.vue`, `${base}.mjs`, `${base}/index.ts`].find(
          (candidate) => sources.has(candidate),
        )
        // Raw text assets (licenses, etc.) have no module dependency graph.
        if (!target && specifier.includes('?raw') && !/\.(?:ts|vue|mjs)$/.test(base)) return
        if (!target) problems.push(`${path}: unresolved local import ${specifier}`)
        else {
          edges.add(target)
          if (path.startsWith('src/') && target.startsWith('server/'))
            problems.push(`${path}: client imports server module ${target}`)
          if (path.startsWith('src/domain/') || path.startsWith('src/application/')) {
            if (/^src\/(?:components|composables|services|presentation)\//.test(target))
              problems.push(`${path}: core imports adapter ${target}`)
          }
          if (path.startsWith('src/domain/') && target.startsWith('src/application/'))
            problems.push(`${path}: domain imports application ${target}`)
          if (
            /^src\/domain\/review[^/]*\.ts$/.test(path) &&
            target === 'src/domain/sheet-drawing.ts'
          )
            problems.push(`${path}: review imports sheet drawing`)
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(ast)
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
      else if (entry.isFile() && /\.(?:ts|vue|mjs)$/.test(path) && !path.endsWith('.d.ts'))
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
