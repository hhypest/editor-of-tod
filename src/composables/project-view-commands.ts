import type { ProjectSession } from './useProjectSession'

/** Views read app stores; only the root session provides workflow commands. */
export type ProjectHubCommands = Pick<
  ProjectSession,
  | 'openRecovery'
  | 'discardRecovery'
  | 'createProject'
  | 'openLocal'
  | 'restoreLocal'
  | 'onFileSelected'
>

export type EditorWorkspaceCommands = Pick<
  ProjectSession,
  | 'saveAsNew'
  | 'exportCurrentProject'
  | 'exportOriginalProject'
  | 'stepBack'
  | 'stepForward'
  | 'onPu66Linked'
  | 'buildDraftTemplate'
  | 'pinCurrentSigns'
  | 'onProjectApplied'
  | 'onDetailsApplied'
>
