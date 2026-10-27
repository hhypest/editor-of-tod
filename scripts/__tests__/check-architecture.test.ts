import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { architectureProblems, readArchitectureSources } from '../check-architecture'

describe('resolved architecture checks', () => {
  it('parses normal script and script setup independently, including attributes containing >', () => {
    const sources = new Map([
      [
        'src/App.vue',
        `<script lang="ts">import type { Model } from '@/domain/model'</script>
        <script setup lang="ts" generic="T extends Record<string, unknown>">
        import { store } from '@/../server/store'
        </script>`,
      ],
      ['src/domain/model.ts', 'export type Model = string'],
      ['server/store.ts', 'export const store = {}'],
    ])
    expect(architectureProblems(sources)).toEqual([
      'src/App.vue: client imports server module server/store.ts',
    ])
  })

  it('ignores script-looking text inside HTML comments and templates', () => {
    expect(
      architectureProblems(
        new Map([
          [
            'src/App.vue',
            `<!-- <script>import '@/missing'</script> -->
        <template><p>&lt;script&gt;import '@/also-missing'&lt;/script&gt;</p></template>`,
          ],
        ]),
      ),
    ).toEqual([])
  })

  it.each([
    '<script setup>import "./missing"',
    '<script>const a = 1</script><script>const b = 2</script>',
    '<template><div></template>',
  ])('reports malformed SFCs instead of silently extracting partial text: %s', (source) => {
    expect(architectureProblems(new Map([['src/App.vue', source]]))).toEqual(
      expect.arrayContaining([expect.stringContaining('src/App.vue: invalid Vue SFC')]),
    )
  })

  it('follows a script src edge and refuses unsupported script languages', () => {
    const sources = new Map([
      ['src/App.vue', '<template><p /></template><script src="../server/entry.ts"></script>'],
      ['server/entry.ts', 'export default {}'],
      ['src/Other.vue', '<script lang="coffee">x = 1</script>'],
    ])
    expect(architectureProblems(sources)).toEqual([
      'src/App.vue: client imports server module server/entry.ts',
      'src/Other.vue: unsupported Vue script language coffee',
    ])
  })

  it.each([
    'import type { A } from "@/application/feature?raw"',
    'export { A } from "../application/feature/index.ts?worker#source"',
    'export * from "../application/feature"',
    'type T = import("@/application/feature").A',
    'const load = import("../application/feature")',
    'const load = import(`@/application/feature`)',
  ])('normalizes static forms to the same indexed module boundary: %s', (source) => {
    expect(
      architectureProblems(
        new Map([
          ['src/domain/model.ts', source],
          ['src/application/feature/index.ts', 'export type A = string'],
        ]),
      ),
    ).toEqual(['src/domain/model.ts: domain imports application src/application/feature/index.ts'])
  })

  it.each([
    'const load = import(path)',
    'const load = import(`./${name}.ts`)',
    'const load = import("./" + name)',
  ])('rejects an unresolvable dynamic import explicitly: %s', (source) => {
    expect(architectureProblems(new Map([['src/services/load.ts', source]]))).toEqual([
      'src/services/load.ts: non-static dynamic import cannot be checked',
    ])
  })

  it('keeps raw assets out of the module graph, but follows raw module dependencies', () => {
    expect(
      architectureProblems(
        new Map([
          [
            'src/services/license.ts',
            'import text from "../../LICENSE?raw"; import "@/domain/model.ts?raw"',
          ],
          ['src/domain/model.ts', 'export const model = 1'],
        ]),
      ),
    ).toEqual([])
    expect(
      architectureProblems(new Map([['src/services/license.ts', 'import "@/missing.ts?raw"']])),
    ).toEqual(['src/services/license.ts: unresolved local import @/missing.ts?raw'])
  })

  it('detects a cycle through both SFC blocks, an index and a type re-export', () => {
    expect(
      architectureProblems(
        new Map([
          [
            'src/View.vue',
            '<script>import "./feature"</script><script setup>import "./other"</script>',
          ],
          ['src/feature/index.ts', 'export type { View } from "../View.vue?raw"'],
          ['src/other.ts', 'export const other = 1'],
        ]),
      ),
    ).toEqual(['Import cycle: src/View.vue -> src/feature/index.ts -> src/View.vue'])
  })

  it('recognizes only the raw query flag as a non-module text asset', () => {
    expect(
      architectureProblems(
        new Map([
          [
            'src/services/license.ts',
            'import "../../LICENSE?other&raw"; import "../../missing.txt?rawish"',
          ],
        ]),
      ),
    ).toEqual(['src/services/license.ts: unresolved local import ../../missing.txt?rawish'])
  })

  it('collects TSX/MTS modules and rejects resolved server, adapter and cycle imports', () => {
    const root = mkdtempSync(join(tmpdir(), 'tod-architecture-'))
    try {
      const files = new Map([
        ['src/domain/a.mts', 'import "../presentation"; import "./b"'],
        ['src/domain/b.tsx', 'import "./a"; export const view = <div />'],
        ['src/presentation/index.tsx', 'import "../../server/store"'],
        ['server/store.mts', 'export const store = {}'],
        ['src/ignored.d.mts', 'import "@/missing"'],
        ['src/ignored.d.ts', 'import "@/missing"'],
        ['src/__tests__/ignored.tsx', 'import "@/missing"'],
      ])
      for (const [path, content] of files) {
        mkdirSync(join(root, path, '..'), { recursive: true })
        writeFileSync(join(root, path), content)
      }
      const sources = readArchitectureSources(root)
      expect([...sources.keys()].sort()).toEqual([
        'server/store.mts',
        'src/domain/a.mts',
        'src/domain/b.tsx',
        'src/presentation/index.tsx',
      ])
      expect(architectureProblems(sources)).toEqual([
        'Import cycle: src/domain/a.mts -> src/domain/b.tsx -> src/domain/a.mts',
        'src/domain/a.mts: core imports adapter src/presentation/index.tsx',
        'src/presentation/index.tsx: client imports server module server/store.mts',
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

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

  it.each(
    ['src/domain/a.ts', 'src/application/a.ts'].flatMap((path) =>
      [
        ['import type { Pinia } from "pinia"', 'pinia'],
        ['export { defineStore } from "pinia"', 'pinia'],
        ['type T = import("pinia/dist/pinia.mjs").Pinia', 'pinia/dist/pinia.mjs'],
        ['const state = import("pinia")', 'pinia'],
        ['const state = import("pinia?raw")', 'pinia?raw'],
      ].map(([source, specifier]) => ({ path, source: source!, specifier })),
    ),
  )('rejects core Pinia dependency: $path / $source', ({ path, source, specifier }) => {
    expect(architectureProblems(new Map([[path, source]]))).toEqual([
      `${path}: core imports Pinia ${specifier}`,
    ])
  })

  it('rejects resolved store imports from both core layers through alias and relative index paths', () => {
    const sources = new Map([
      ['src/domain/a.ts', 'export { state } from "@/stores/normative"'],
      ['src/application/a.ts', 'type T = import("../stores/normative/index.ts?raw").State'],
      ['src/stores/normative/index.ts', 'export const state = {}; export type State = string'],
    ])
    expect(architectureProblems(sources)).toEqual([
      'src/application/a.ts: core imports adapter src/stores/normative/index.ts',
      'src/domain/a.ts: core imports adapter src/stores/normative/index.ts',
    ])
  })

  it('allows stores to compose services and domain while a compatible facade reads the store', () => {
    const sources = new Map([
      [
        'src/composables/useRules.ts',
        'import "../stores/rules"; import { storeToRefs } from "pinia"',
      ],
      [
        'src/stores/rules.ts',
        'import { defineStore } from "pinia"; import "../domain/rules"; import "../services/api"',
      ],
      ['src/services/api.ts', 'import "../domain/rules"'],
      ['src/domain/rules.ts', 'export const rules = {}'],
    ])
    expect(architectureProblems(sources)).toEqual([])
  })
})
