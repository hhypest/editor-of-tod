import { describe, expect, it } from 'vitest'
import { documentationProblems, markdownInfo } from '../check-documentation'

const current = '# Документ\n\nТип: действующая справка.\n'
function fixture(entries: Record<string, string>) {
  const docs = Object.keys(entries).filter((p) => /\.md$/i.test(p))
  return new Map([
    ['package.json', JSON.stringify({ scripts: { check: 'x', test: 'x', 'test:e2e': 'x' } })],
    ...Object.entries(entries),
    [
      'docs/catalog.md',
      '# Каталог\n\nТип: реестр документов.\n\nКаталог охватывает ' +
        (docs.length + 1) +
        ' Markdown-документов.\n\n| Документ |\n| --- |\n| [Каталог](catalog.md) |\n' +
        docs
          .map(
            (p) =>
              '| [Документ](' + encodeURI(p.startsWith('docs/') ? p.slice(5) : '../' + p) + ') |',
          )
          .join('\n'),
    ],
  ])
}
const rules = (sources: Map<string, string>) => documentationProblems(sources).map((p) => p.rule)

describe('documentation contracts', () => {
  it('resolves UTF-8, directories, query strings, explicit IDs and duplicate anchors', () => {
    const sources = fixture({
      'docs/a.md':
        current +
        '\n[Текст](документ%20один.md?plain=1#проверка-1) [ID](#named) [Каталог](../src/)\n<a id="named"></a>',
      'docs/документ один.md': current + '\n## Проверка\n## Проверка\n',
      'src/file.ts': '',
    })
    expect(documentationProblems(sources)).toEqual([])
  })
  it('ignores headings and links inside fenced code with a longer inner marker', () => {
    const info = markdownInfo(
      '# A\n````markdown\n```\n# Example\n[x](missing.md)\n````\n## Visible',
    )
    expect([...info.anchors]).toEqual(['a', 'visible'])
    expect(info.links).toEqual([])
    expect(markdownInfo('```text\n```javascript\n[x](missing.md)\n```').links).toEqual([])
  })
  it('reports missing targets and anchors with the source line and preserves case sensitivity', () => {
    const sources = fixture({ 'docs/a.md': current + '\n[x](A.md) [y](#absent)\n' })
    const problems = documentationProblems(sources)
    expect(problems.map((p) => [p.rule, p.line])).toEqual([
      ['link', 5],
      ['anchor', 5],
    ])
  })
  it('supports reference definitions and reports an undefined reference or malformed encoding', () => {
    const sources = fixture({
      'docs/a.md': current + '\n[x][ok] [missing][no] [bad](%ZZ.md)\n[ok]: a.md\n',
    })
    expect(rules(sources).sort()).toEqual(['link', 'reference'])
  })
  it('requires active metadata outside code fences and before the first section', () => {
    for (const source of [
      '# A\n```text\nТип: действующая справка.\n```',
      '# A\n## Section\nТип: действующая справка.',
    ])
      expect(rules(fixture({ 'docs/a.md': source }))).toEqual(['type'])
  })
  it('checks historical provenance without banning old versions, commands or retired code names', () => {
    const old =
      '# Old\n\n> **Архив исходного документа.** 30.10.2026 [source](https://github.com/example/repo/blob/' +
      'a'.repeat(40) +
      '/old.md).\n\nJSON v7; npm run retired; `server/store.ts`\n'
    expect(documentationProblems(fixture({ 'docs/archive/old.md': old }))).toEqual([])
    expect(
      documentationProblems(
        fixture({
          'docs/verification/reports/old.md':
            '# Report\n\nТип: протокол завершённой проверки.\n\nJSON v7; npm run retired; `server/store.ts`',
        }),
      ),
    ).toEqual([])
    expect(rules(fixture({ 'docs/archive/old.md': old.replace('a'.repeat(40), 'main') }))).toEqual([
      'provenance',
    ])
    expect(rules(fixture({ 'docs/adr/0001.md': '# ADR\n\n## Context\n' }))).toEqual(['status'])
  })
  it('requires catalog table coverage before the previous-path map and an exact count', () => {
    const sources = fixture({ 'docs/a.md': current })
    sources.set(
      'docs/catalog.md',
      sources
        .get('docs/catalog.md')!
        .replace('| [Документ](a.md) |', '## Карта прежних путей\n\n| [Документ](a.md) |')
        .replace('охватывает 2', 'охватывает 1'),
    )
    expect(rules(sources).sort()).toEqual(['catalog', 'count'])
  })
  it('checks commands and current code paths while keeping one documented historical diagnostic frame', () => {
    const sources = fixture({
      'docs/engineering/diagnostics.md':
        current + '\nИсторический `server/store.ts`; npm run check\n',
      'docs/a.md': current + '\nnpm run removed\n`server/store.ts`\n',
    })
    expect(documentationProblems(sources).map((p) => [p.path, p.rule])).toEqual([
      ['docs/a.md', 'command'],
      ['docs/a.md', 'code-path'],
    ])
  })
  it('requires both installed browsers in full E2E workflows', () => {
    const sources = fixture({
      'docs/a.md': current,
      '.github/workflows/ci.yml': '- run: npx playwright install --with-deps chromium',
    })
    expect(rules(sources)).toEqual(['browsers'])
    sources.set(
      '.github/workflows/ci.yml',
      '- run: npx playwright install --with-deps chromium firefox',
    )
    expect(documentationProblems(sources)).toEqual([])
  })
  it('does not treat an external URL or its fragment as a local file', () => {
    expect(
      documentationProblems(
        fixture({
          'docs/a.md':
            current +
            '\n[x](https://example.com/old.md#no-local-anchor) [mail](mailto:example@example.com)',
        }),
      ),
    ).toEqual([])
  })
})
