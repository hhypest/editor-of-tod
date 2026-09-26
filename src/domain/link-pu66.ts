import { schemeSchema, type Scheme } from './model'
import { pu66SchemeRecordSchema, type Pu66SchemeRecord } from './pu66-snapshot'

/** Replaces only the crossing reference and its small, versioned snapshot. */
export function linkPu66Card(scheme: Scheme, selected: Pu66SchemeRecord): Scheme {
  const { referenceId, ...snapshot } = pu66SchemeRecordSchema.parse(selected)
  return schemeSchema.parse({
    ...scheme,
    crossing: { referenceId, source: 'local-pu66', snapshot },
  })
}
