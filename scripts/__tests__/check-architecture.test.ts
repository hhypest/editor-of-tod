import { describe, expect, it } from 'vitest'
import { architectureProblems } from '../check-architecture'

describe('resolved architecture checks', () => {
  it('rejects server imports after alias and relative path normalization, including Vue', () => {
    const sources = new Map([
      ['src/App.vue', '<script setup lang="ts">import store from "@/../server/store.ts"</script>'],
      ['src/services/local.ts', 'export { store } from "../../server/store.ts"'],
      ['server/store.ts', 'export const store = {}'],
    ])
    expect(architectureProblems(sources)).toEqual([
      'src/App.vue: client imports server module server/store.ts',
      'src/services/local.ts: client imports server module server/store.ts',
    ])
  })

  it('rejects core-to-adapter and domain-to-application imports, including type imports', () => {
    const sources = new Map([
      [
        'src/domain/model.ts',
        'import type { A } from "@/application/a"; type T = import("@/presentation/review").T',
      ],
      ['src/application/a.ts', 'const view = import("../presentation/review")'],
      ['src/presentation/review.ts', 'export type T = string'],
    ])
    expect(architectureProblems(sources)).toEqual([
      'src/application/a.ts: core imports adapter src/presentation/review.ts',
      'src/domain/model.ts: core imports adapter src/presentation/review.ts',
      'src/domain/model.ts: domain imports application src/application/a.ts',
    ])
  })

  it('rejects cycles across aliases, type imports and dynamic imports', () => {
    const sources = new Map([
      ['src/domain/a.ts', 'import type { B } from "@/domain/b"'],
      ['src/domain/b.ts', 'export const a = import("./a.ts")'],
    ])
    expect(architectureProblems(sources)).toEqual([
      'Import cycle: src/domain/a.ts -> src/domain/b.ts -> src/domain/a.ts',
    ])
  })

  it('rejects an unresolved internal dependency and review-to-drawing import', () => {
    const sources = new Map([
      ['src/domain/review-scheme.ts', 'import "./sheet-drawing"; import "@/missing"'],
      ['src/domain/sheet-drawing.ts', 'export const node = {}'],
    ])
    expect(architectureProblems(sources)).toEqual([
      'src/domain/review-scheme.ts: review imports sheet drawing',
      'src/domain/review-scheme.ts: unresolved local import @/missing',
    ])
  })

  it('allows independent core consumers, server-to-core imports and external libraries', () => {
    const sources = new Map([
      ['src/domain/a.ts', 'import { z } from "zod"'],
      ['src/application/b.ts', 'export { A } from "../domain/a"'],
      ['src/presentation/c.ts', 'import { B } from "@/application/b"'],
      ['server/api.ts', 'import "../src/domain/a.ts"'],
    ])
    expect(architectureProblems(sources)).toEqual([])
  })
})
