import { globalIgnores } from 'eslint/config'
import { defineConfigWithVueTs, vueTsConfigs } from '@vue/eslint-config-typescript'
import pluginVue from 'eslint-plugin-vue'
import pluginOxlint from 'eslint-plugin-oxlint'
import skipFormatting from 'eslint-config-prettier/flat'

// To allow more languages other than `ts` in `.vue` files, uncomment the following lines:
// import { configureVueProject } from '@vue/eslint-config-typescript'
// configureVueProject({ scriptLangs: ['ts', 'tsx'] })
// More info at https://github.com/vuejs/eslint-config-typescript/#advanced-setup

export default defineConfigWithVueTs(
  {
    name: 'app/files-to-lint',
    files: ['**/*.{vue,ts,mts,tsx}'],
  },

  globalIgnores(['**/dist/**', '**/dist-ssr/**', '**/coverage/**', 'release/**']),

  ...pluginVue.configs['flat/essential'],
  vueTsConfigs.recommended,

  ...pluginOxlint.buildFromOxlintConfigFile('.oxlintrc.json'),

  {
    name: 'app/core-boundaries',
    files: ['src/domain/**/*.ts', 'src/application/**/*.ts'],
    ignores: ['**/__tests__/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                'vue',
                'vue/**',
                'node:*',
                '**/components/**',
                '**/composables/**',
                '**/services/**',
                '**/server/**',
              ],
              message:
                'Предметные правила и сценарии зависят от данных и узких интерфейсов, а не от UI, HTTP или SQLite (ADR-0006).',
            },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        'window',
        'document',
        'navigator',
        'fetch',
        'localStorage',
        'sessionStorage',
        'indexedDB',
      ],
    },
  },

  {
    name: 'app/domain-direction',
    files: ['src/domain/**/*.ts'],
    ignores: ['**/__tests__/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                'vue',
                'vue/**',
                'node:*',
                '**/components/**',
                '**/composables/**',
                '**/services/**',
                '**/server/**',
                '**/application/**',
              ],
              message: 'Предметная модель не зависит от сценариев и адаптеров (ADR-0006).',
            },
          ],
        },
      ],
    },
  },

  skipFormatting,
)
