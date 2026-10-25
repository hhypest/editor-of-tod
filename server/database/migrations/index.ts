import type { Migration } from './migration.ts'
import { initialSchema } from './v00-v01-initial.ts'
import { pu66AndSigns } from './v01-v03-pu66-signs.ts'
import { removeLegacySvg } from './v02-v03-remove-svg.ts'
import { projectHistory } from './v03-v04-projects.ts'
import { pu66Verifications } from './v04-v05-pu66-verifications.ts'
import { signHistory } from './v05-v06-sign-history.ts'
import { projectSources } from './v06-v07-project-sources.ts'
import { recoveryDrafts } from './v07-v08-recovery.ts'
import { stationPu66Keys } from './v08-v09-station-keys.ts'
import { normativeDocuments } from './v09-v10-documents.ts'
import { documentText } from './v10-v11-document-text.ts'
import { pu66Lifecycle } from './v11-v12-pu66-lifecycle.ts'
import { recoveryOwnership } from './v12-v13-recovery-ownership.ts'

export const migrations: readonly Migration[] = [
  initialSchema,
  pu66AndSigns,
  removeLegacySvg,
  projectHistory,
  pu66Verifications,
  signHistory,
  projectSources,
  recoveryDrafts,
  stationPu66Keys,
  normativeDocuments,
  documentText,
  pu66Lifecycle,
  recoveryOwnership,
]
