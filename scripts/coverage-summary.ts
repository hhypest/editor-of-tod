/** Publish measured coverage, without changing thresholds or hiding untested source files. */
import { appendFileSync, existsSync, readFileSync } from 'node:fs'

const file = 'coverage/coverage-summary.json'
if (!existsSync(file)) {
  console.log('Coverage report unavailable: the validation job may have failed before tests.')
} else {
  type Metric = { covered: number; total: number; pct: number }
  const report = JSON.parse(readFileSync(file, 'utf8')) as Record<string, Record<string, Metric>>
  const total = report.total!
  // Mocked SFCs can otherwise appear as zero-line files and inflate the aggregate.
  // The real-SFC import contract makes their executable code visible to V8.
  const unmeasured = Object.entries(report).filter(
    ([path, metrics]) => path.endsWith('.vue') && metrics.lines?.total === 0,
  )
  if (unmeasured.length) throw new Error(`Coverage omitted executable SFCs: ${unmeasured.length}`)
  const lines = ['### Test coverage', '', '| Metric | Covered / total | % |', '| --- | --- | --- |']
  for (const key of ['lines', 'statements', 'functions', 'branches']) {
    const value = total[key]!
    lines.push(`| ${key} | ${value.covered} / ${value.total} | ${value.pct} |`)
  }
  const text = `${lines.join('\n')}\n`
  console.log(text)
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text)
}
