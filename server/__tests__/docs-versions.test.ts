import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { schemeSchema } from '../../src/domain/model'
import { SCHEMA_VERSION } from '../store'

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')
const project = schemeSchema.shape.schemaVersion.value

/** Документация отставала от формата дважды (CR-11 и срез 05.10.2026): сверяем её с кодом. */
describe('documentation states the current format versions', () => {
  it('names the current project format where a tester or an agent reads it', () => {
    expect(read('AGENTS.md')).toContain(`редактирование проекта v${project}`)
    expect(read('AGENTS.md')).toContain(`\`schemaVersion\` 2–${project - 1}`)
    expect(read('README.md')).toContain(`текущий формат проекта — v${project}`)
    expect(read('docs/architecture.md')).toContain(`\`schemaVersion: ${project}\``)
    expect(read('docs/migration.md')).toContain(`\`schemaVersion: 2–${project}\``)
    expect(read('docs/migration.md')).toContain(`работают в формате v${project}`)
    expect(read('docs/scheme-format.md')).toContain(`v2–v${project} до 32 МБ`)
  })

  it('does not tell the tester to expect a previous version in a downloaded file', () => {
    const testing = read('TESTING.MD')
    const stated = [
      ...testing.matchAll(/`schemaVersion: (\d+)`/g),
      ...testing.matchAll(/scheme_[A-Z0-9-]+_v(\d+)\.json/g),
    ].map((match) => Number(match[1]))
    expect(stated.length).toBeGreaterThan(0)
    expect([...new Set(stated)]).toEqual([project])
    expect(testing).toContain(`\`schemaVersion: 2–${project}\``)
    const previous = Array.from({ length: project - 2 }, (_, index) => index + 2).join('|')
    expect(testing).not.toMatch(new RegExp(`schemaVersion: 2–(?:${previous})(?!\\d)`))
  })

  it('names the current database version', () => {
    expect(read('TESTING.MD')).toContain(`обновляется до версии ${SCHEMA_VERSION}:`)
    expect(read('docs/architecture.md')).toContain(`SQLite версии ${SCHEMA_VERSION}`)
  })
})
