/** Overlapping selectors describe existing boundaries, not a full module responsibility model. */
export const moduleLayers = {
  client: /^src\//,
  server: /^server\//,
  core: /^src\/(?:domain|application)\//,
  domain: /^src\/domain\//,
  historicalFormat: /^src\/domain\/formats\/frozen\//,
  currentDomain: /^src\/domain\/(?!formats\/frozen\/)/,
  application: /^src\/application\//,
  adapter: /^src\/(?:components|composables|services|presentation|stores)\//,
  review: /^src\/domain\/review[^/]*\.(?:ts|tsx|mts)$/,
  drawing: /^src\/domain\/sheet-drawing\.ts$/,
} as const

export const localImportRules = [
  {
    from: 'historicalFormat',
    to: 'currentDomain',
    message: 'historical format imports current domain',
    includeTarget: true,
  },
  { from: 'client', to: 'server', message: 'client imports server module', includeTarget: true },
  { from: 'core', to: 'adapter', message: 'core imports adapter', includeTarget: true },
  { from: 'domain', to: 'application', message: 'domain imports application', includeTarget: true },
  { from: 'review', to: 'drawing', message: 'review imports sheet drawing', includeTarget: false },
] as const satisfies ReadonlyArray<{
  from: keyof typeof moduleLayers
  to: keyof typeof moduleLayers
  message: string
  includeTarget: boolean
}>

export const externalImportRules = [
  { from: 'core', specifier: /^pinia(?:\/|$)/, message: 'core imports Pinia' },
] as const satisfies ReadonlyArray<{
  from: keyof typeof moduleLayers
  specifier: RegExp
  message: string
}>
