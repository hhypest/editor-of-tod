import type { Ref } from 'vue'
import type { Scheme } from '../domain/model'
import {
  exportSchemeJson,
  importSchemeJson,
  MAX_PROJECT_FILE_BYTES,
  SchemeImportError,
} from '../domain/import'
import type { useProjectDocument } from './useProjectDocument'
import { reportError } from '../services/diagnostics'

export const PU66_LINKED_WARNING =
  'Локальная карточка ПУ-66 закреплена как снимок; её актуальность нужно проверить.'

export interface ProjectFileEditor {
  projectDocument: Pick<
    ReturnType<typeof useProjectDocument>,
    'imported' | 'errorMessage' | 'loading' | 'clearDocument' | 'openDocument'
  >
  editorDirty: Readonly<Ref<boolean>>
  hasUnsavedWork: Readonly<Ref<boolean>>
  localError: Ref<string>
  localNotice: Ref<string>
  beginSession(): void
  flushRecovery(): Promise<boolean>
  onProjectOpened(): void
}

export function useProjectFiles(
  editor: ProjectFileEditor,
  download: (scheme: Scheme, content: string, suffix: string) => void,
) {
  const {
    projectDocument,
    editorDirty,
    hasUnsavedWork,
    localError,
    localNotice,
    beginSession,
    flushRecovery,
    onProjectOpened,
  } = editor
  const { imported, errorMessage, loading } = projectDocument
  async function onFileSelected(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement
    const file = input.files?.[0]
    input.value = ''
    if (!file) return
    if (
      hasUnsavedWork.value &&
      !window.confirm('Есть правки без сохранённой копии. Открыть другой проект?')
    )
      return
    if (hasUnsavedWork.value && !(await flushRecovery())) return

    beginSession()
    projectDocument.clearDocument(file.name)
    localError.value = ''
    localNotice.value = ''

    if (file.size > MAX_PROJECT_FILE_BYTES) {
      errorMessage.value = 'Файл проекта больше 32 МБ.'
      return
    }

    loading.value = true
    try {
      const result = importSchemeJson(await file.text())
      projectDocument.openDocument({
        result,
        fileName: file.name,
        revision: null,
        modified: false,
        selectedPlacementId: result.scheme.placements[0]?.id ?? null,
      })
      onProjectOpened()
    } catch (error) {
      // Журнал получает только тип ошибки и место кода; имя файла и введённые значения не записываются.
      reportError('Открытие JSON-проекта', error)
      errorMessage.value =
        error instanceof SchemeImportError ? error.message : 'Не удалось прочитать выбранный файл.'
    } finally {
      loading.value = false
    }
  }

  function downloadProjectJson(content: string, suffix: string): void {
    const scheme = imported.value?.scheme
    if (scheme) download(scheme, content, suffix)
  }

  function exportCurrentProject(): void {
    if (imported.value && !editorDirty.value) {
      downloadProjectJson(exportSchemeJson(imported.value.scheme), 'v10')
    }
  }

  function exportOriginalProject(): void {
    if (imported.value?.scheme.source.kind === 'legacy-html-v1') {
      downloadProjectJson(imported.value.scheme.source.originalJson, 'original_v1')
    }
  }

  async function createProject(scheme: Scheme): Promise<void> {
    if (scheme.crossing.source !== 'local-pu66') {
      localError.value = 'Новую схему можно начать только с карточки ПУ-66 из локального реестра.'
      return
    }
    if (
      hasUnsavedWork.value &&
      !window.confirm('Есть правки без сохранённой копии. Создать другой проект?')
    )
      return
    if (hasUnsavedWork.value && !(await flushRecovery())) return
    beginSession()
    projectDocument.openDocument({
      result: {
        scheme,
        format: 'scheme-v10',
        warnings: [
          PU66_LINKED_WARNING,
          'Вариант выбран по длине фронта работ, нормативная проверка и расстановка знаков не выполнены.',
        ],
      },
      fileName: 'Новый проект · не сохранён',
      revision: null,
      modified: true,
      selectedPlacementId: null,
    })
    localError.value = ''
    localNotice.value = ''
    errorMessage.value = ''
    onProjectOpened()
  }

  return { onFileSelected, exportCurrentProject, exportOriginalProject, createProject }
}
