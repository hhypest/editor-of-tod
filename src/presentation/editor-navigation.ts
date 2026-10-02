export const editorStages = ['source', 'geometry', 'objects', 'review'] as const
export type EditorView = 'projects' | (typeof editorStages)[number] | 'registries' | 'help'
export type ProjectTab = 'new' | 'file' | 'local'
export type RegistryTab = 'imports' | 'documents' | 'parameters' | 'entries' | 'diagnostics'
export type SetupImportTarget = 'pdf-sign-import' | 'pu66-import'
