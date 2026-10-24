import type { ProjectRecord } from '../domain/local-projects'
import type { ProjectRevisionRepository } from '../application/project-revisions'
import { useProjectRevisionActions, type RevisionEditor } from './useProjectRevisionActions'

export interface ProjectPersistenceRepository extends ProjectRevisionRepository {
  get(id: string): Promise<ProjectRecord>
}

/** Local reads and existing save/restore workflows share the same editor and operation lock. */
export function useProjectPersistence(
  editor: RevisionEditor,
  repository: ProjectPersistenceRepository,
) {
  const revisions = useProjectRevisionActions(editor, repository)

  async function openLocal(id: string): Promise<void> {
    if (editor.localBusy.value || editor.loading.value) return
    if (
      editor.hasUnsavedWork.value &&
      !window.confirm('Есть несохранённые правки. Открыть другой проект?')
    )
      return
    if (editor.hasUnsavedWork.value && !(await editor.flushRecovery())) return
    editor.localBusy.value = true
    editor.localError.value = ''
    editor.localNotice.value = ''
    try {
      const record = await repository.get(id)
      editor.openProjectRecord(record.scheme, record.revision, record.storedSchemaVersion)
    } catch (cause) {
      editor.showLocalError(cause)
    } finally {
      editor.localBusy.value = false
    }
  }

  return { ...revisions, openLocal }
}
