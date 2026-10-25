import { computed, ref } from 'vue'
import { storedFormatWarnings } from '../domain/import'
import type { Scheme } from '../domain/model'
import { loadSignCatalogSnapshot } from '../services/local-signs'
import { reportError } from '../services/diagnostics'
import { localApiErrorCode } from '../services/api-error'
import { useNormativeRules } from './useNormativeRules'
import {
  getLocalProject,
  listRecoveryDrafts,
  restoreLocalRevision,
  saveLocalProject,
  createRecoveryRepository,
} from '../services/local-projects'
import { useProjectRecovery } from './useProjectRecovery'
import { useBrowserLifecycle } from './useBrowserLifecycle'
import { useSessionCursor } from './useSessionCursor'
import { useProjectPersistence } from './useProjectPersistence'
import { useProjectHistory } from './useProjectHistory'
import { useEditorDraftState } from './useEditorDraftState'
import { useProjectFiles, PU66_LINKED_WARNING } from './useProjectFiles'
import { useRecoveryActions } from './useRecoveryActions'
import { downloadProjectJson } from '../services/project-download'
import { useTemplateActions } from './useTemplateActions'
import { useProjectDocument } from './useProjectDocument'

/** Composes one stable editor session from document, workflow and infrastructure adapters. */

export function useProjectSession(onProjectOpened: () => void) {
  const { rules: normativeRules } = useNormativeRules()
  const drafts = useEditorDraftState()
  const edits = useProjectHistory()
  const projectDocument = useProjectDocument(drafts, edits)
  const {
    imported,
    selectedFileName,
    errorMessage,
    loading,
    modifiedSinceLocalSave,
    localRevision,
    selectedPlacementId,
  } = projectDocument
  const {
    detailsDirty,
    placementDirty,
    pendingDetails,
    pendingPlacement,
    recoverySeed,
    editorDirty,
  } = drafts
  const { history } = edits
  const localBusy = ref(false)
  const localError = ref('')
  const localNotice = ref('')
  const projectsRefreshKey = ref(0)
  const {
    templateMessage,
    templateError,
    signPinMessage,
    onDetailsApplied,
    buildDraftTemplate,
    pinCurrentSigns,
  } = useTemplateActions(
    {
      imported,
      editorDirty,
      localBusy,
      selectedPlacementId,
      normativeRules,
      onProjectApplied: projectDocument.commitScheme,
    },
    { loadCatalog: loadSignCatalogSnapshot },
  )
  const hasUnsavedWork = computed(() => editorDirty.value || modifiedSinceLocalSave.value)
  const cursor = useSessionCursor([
    () => imported.value?.scheme,
    detailsDirty,
    placementDirty,
    pendingDetails,
    pendingPlacement,
  ])
  const revisionCursor = cursor.snapshot
  const recovery = useProjectRecovery({
    initialId: crypto.randomUUID(),
    repository: createRecoveryRepository(crypto.randomUUID()),
    list: listRecoveryDrafts,
    hasUnsavedWork,
    changes: [
      imported,
      detailsDirty,
      placementDirty,
      pendingDetails,
      pendingPlacement,
      modifiedSinceLocalSave,
      localRevision,
    ],
    showError: showLocalError,
    snapshot(sessionId) {
      if (!imported.value || !hasUnsavedWork.value) return null
      return {
        sessionId,
        scheme: imported.value.scheme,
        baseRevision: localRevision.value,
        detailsDraft: pendingDetails.value,
        placementDraft: pendingPlacement.value,
        fileName: selectedFileName.value,
      }
    },
  })
  const {
    recoveryCopies,
    recoveryStatus,
    activeRecoveryId,
    flush: flushRecovery,
    clear: clearRecovery,
  } = recovery

  function beginSession(sessionId: string = crypto.randomUUID()): void {
    cursor.begin()
    recovery.begin(sessionId)
    drafts.clearPending()
    templateMessage.value = ''
    templateError.value = ''
  }

  useBrowserLifecycle({
    start: recovery.start,
    stop() {
      cursor.begin()
      recovery.stop()
    },
    beforeUnload: recovery.beforeUnload,
    pageHide: recovery.releaseOnExit,
    visible: () => void recovery.heartbeat(),
  })

  function showLocalError(cause: unknown): void {
    // Текст ответа базы может содержать ключ переезда или имя файла — пишется только тип ошибки.
    reportError('Операция с локальной базой', cause)
    localError.value =
      cause instanceof Error ? cause.message : 'Операция с локальной базой не удалась.'
    if (localApiErrorCode(cause) === 'revision-conflict') {
      localError.value += ' Ваши правки остались открытыми. Обновите список проектов.'
      localError.value +=
        ' Для отдельной копии сначала примените ввод в формах, затем используйте «Сохранить как новый проект» в «Действия с проектом».'
    }
  }

  const { saveLocally, saveAsNew, restoreLocal, openLocal } = useProjectPersistence(
    {
      imported,
      history,
      localRevision,
      localBusy,
      loading,
      editorDirty,
      hasUnsavedWork,
      modifiedSinceLocalSave,
      selectedFileName,
      localError,
      localNotice,
      projectsRefreshKey,
      cursor: revisionCursor,
      recoveryId: () => activeRecoveryId.value,
      beginSession,
      openProjectRecord,
      flushRecovery,
      clearRecovery,
      showLocalError,
    },
    { save: saveLocalProject, restore: restoreLocalRevision, get: getLocalProject },
  )

  function openProjectRecord(scheme: Scheme, revision: number, storedSchemaVersion?: number): void {
    beginSession()
    projectDocument.openDocument({
      result: {
        scheme,
        format: 'scheme-v10',
        warnings: [
          'Схема не прошла нормативную проверку.',
          ...(storedSchemaVersion !== undefined
            ? storedFormatWarnings(storedSchemaVersion, scheme)
            : []),
        ],
      },
      fileName: `Сохранённый проект · версия ${revision}`,
      revision,
      modified: false,
      selectedPlacementId: scheme.placements[0]?.id ?? null,
    })
    onProjectOpened()
  }

  const onProjectApplied = projectDocument.commitScheme

  function onPu66Linked(scheme: Scheme): void {
    onProjectApplied(scheme)
    if (!imported.value) return
    imported.value = {
      ...imported.value,
      warnings: [
        ...imported.value.warnings.filter(
          (warning) => !warning.startsWith('Локальная карточка ПУ-66 закреплена'),
        ),
        PU66_LINKED_WARNING,
      ],
    }
  }

  function stepBack(): void {
    if (!projectDocument.stepHistory('back')) return
    templateMessage.value = ''
    templateError.value = ''
  }

  function stepForward(): void {
    if (!projectDocument.stepHistory('forward')) return
    templateMessage.value = ''
    templateError.value = ''
  }

  const { onFileSelected, exportCurrentProject, exportOriginalProject, createProject } =
    useProjectFiles(
      {
        projectDocument,
        editorDirty,
        hasUnsavedWork,
        localError,
        localNotice,
        beginSession,
        flushRecovery,
        onProjectOpened,
      },
      downloadProjectJson,
    )
  const { openRecovery, discardRecovery } = useRecoveryActions(
    {
      projectDocument,
      drafts,
      loading,
      localBusy,
      localError,
      localNotice,
      hasUnsavedWork,
      beginSession,
      onProjectOpened,
      showLocalError,
    },
    recovery,
  )

  return {
    imported,
    selectedFileName,
    errorMessage,
    loading,
    detailsDirty,
    placementDirty,
    modifiedSinceLocalSave,
    localRevision,
    localBusy,
    localError,
    localNotice,
    projectsRefreshKey,
    history,
    selectedPlacementId,
    templateMessage,
    templateError,
    onDetailsApplied,
    signPinMessage,
    editorDirty,
    hasUnsavedWork,
    recoveryCopies,
    activeRecoveryId,
    recoveryStatus,
    recoverySeed,
    pendingDetails,
    pendingPlacement,
    openRecovery,
    discardRecovery,
    onFileSelected,
    exportCurrentProject,
    exportOriginalProject,
    /** @deprecated Use exportCurrentProject. Kept during the compatible session refactoring. */
    saveV5: exportCurrentProject,
    /** @deprecated Use exportOriginalProject. */
    saveOriginal: exportOriginalProject,
    createProject,
    saveLocally,
    saveAsNew,
    openLocal,
    restoreLocal,
    onProjectApplied,
    buildDraftTemplate,
    pinCurrentSigns,
    onPu66Linked,
    stepBack,
    stepForward,
  }
}

/** Shared refs and commands for the one editor window; child views never construct a session. */
export type ProjectSession = ReturnType<typeof useProjectSession>
