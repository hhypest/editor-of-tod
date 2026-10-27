import { builtinEnvironments, type Environment } from 'vitest/runtime'

/** Keep Node's test globals, but compile SFCs for the custom client renderer. */
export default {
  ...builtinEnvironments.node,
  name: 'vue-renderer',
  viteEnvironment: 'client',
} satisfies Environment
