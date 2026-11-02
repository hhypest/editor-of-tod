import { nextTick, type Ref } from 'vue'
import type { useProjectDocument } from './useProjectDocument'
import type { useProjectRecovery } from './useProjectRecovery'
import type { EditorDraftState } from './useEditorDraftState'

export interface RecoveryActionEditor {
  projectDocument: Pick<ReturnType<typeof useProjectDocument>, 'openDocument'>
  drafts: Pick<
    EditorDraftState,
    'pendingDetails' | 'pendingPlacement' | 'pendingRoadNode' | 'recoverySeed'
  >
  loading: Readonly<Ref<boolean>>
  localBusy: Ref<boolean>
  localError: Ref<string>
  localNotice: Ref<string>
  hasUnsavedWork: Readonly<Ref<boolean>>
  beginSession(id: string): void
  onProjectOpened(): void
  showLocalError(cause: unknown): void
}

type RecoveryActions = Pick<
  ReturnType<typeof useProjectRecovery>,
  'recoveryCopies' | 'activeRecoveryId' | 'flush' | 'claim' | 'remove' | 'refresh'
>

/** Confirms opening and hydrates the saved form input after the document view is mounted. */
export function useRecoveryActions(editor: RecoveryActionEditor, recovery: RecoveryActions) {
  const {
    projectDocument,
    loading,
    localBusy,
    localError,
    localNotice,
    hasUnsavedWork,
    beginSession,
    onProjectOpened,
    showLocalError,
  } = editor
  const { pendingDetails, pendingPlacement, pendingRoadNode, recoverySeed } = editor.drafts
  const {
    recoveryCopies,
    activeRecoveryId,
    flush: flushRecovery,
    refresh: refreshRecoveries,
  } = recovery
  async function openRecovery(sessionId: string): Promise<void> {
    if (localBusy.value || loading.value) return
    if (
      hasUnsavedWork.value &&
      !window.confirm('Есть правки без сохранённой копии. Открыть копию восстановления?')
    )
      return
    if (hasUnsavedWork.value && !(await flushRecovery())) return
    localBusy.value = true
    localError.value = ''
    try {
      const version = recoveryCopies.value.find((copy) => copy.sessionId === sessionId)?.version
      if (!version) throw new Error('Обновите список копий восстановления.')
      const record = await recovery.claim(sessionId, version)
      const roadNode = record.placementDraft?.kind === 'road-node' ? record.placementDraft : null
      const placement = record.placementDraft?.kind === 'road-node' ? null : record.placementDraft
      beginSession(record.sessionId)
      projectDocument.openDocument({
        result: {
          scheme: record.scheme,
          format: 'scheme-v13',
          warnings: ['Восстановлена рабочая копия; проверьте ввод и сохраните проект.'],
        },
        fileName: record.fileName,
        revision: record.baseRevision,
        modified: true,
        selectedPlacementId: placement?.id ?? record.scheme.placements[0]?.id ?? null,
        selectedRoadNodeId: roadNode?.id ?? null,
      })
      onProjectOpened()
      await nextTick()
      pendingDetails.value = record.detailsDraft
      pendingPlacement.value = placement
      pendingRoadNode.value = roadNode
      recoverySeed.value = {
        details: record.detailsDraft,
        placement,
        ...(roadNode ? { roadNode } : {}),
      }
      localNotice.value = 'Рабочая копия восстановлена. Примените ввод в форме и сохраните проект.'
    } catch (cause) {
      showLocalError(cause)
    } finally {
      localBusy.value = false
    }
  }

  async function discardRecovery(sessionId: string, version: number): Promise<void> {
    if (localBusy.value || sessionId === activeRecoveryId.value) return
    localBusy.value = true
    localError.value = ''
    try {
      await recovery.remove(sessionId, version)
      await refreshRecoveries()
    } catch (cause) {
      showLocalError(cause)
    } finally {
      localBusy.value = false
    }
  }

  return { openRecovery, discardRecovery }
}
