import type { Ref } from 'vue'
import type { ImportResult } from '../domain/import'
import type { Scheme } from '../domain/model'
import { startHistory, type EditHistory } from '../domain/edit-history'
import {
  RestoreProjectRevision,
  SaveProjectRevision,
  revisionDelivery,
  type ProjectRevisionRepository,
  type RevisionCursor,
} from '../application/project-revisions'

type RevisionEditor = {
  imported: Ref<ImportResult | null>
  history: Ref<EditHistory<Scheme> | null>
  localRevision: Ref<number | null>
  localBusy: Ref<boolean>
  loading: Ref<boolean>
  editorDirty: Readonly<Ref<boolean>>
  hasUnsavedWork: Readonly<Ref<boolean>>
  modifiedSinceLocalSave: Ref<boolean>
  selectedFileName: Ref<string>
  localError: Ref<string>
  localNotice: Ref<string>
  projectsRefreshKey: Ref<number>
  cursor(): RevisionCursor
  recoveryId(): string
  beginSession(): void
  openProjectRecord(scheme: Scheme, revision: number): void
  flushRecovery(): Promise<boolean>
  clearRecovery(id: string): Promise<void>
  showLocalError(cause: unknown): void
}

/** Vue adapter owns confirmation, notices and recovery; workflows own revision writes. */
export function useProjectRevisionActions(
  editor: RevisionEditor,
  repository: ProjectRevisionRepository,
) {
  const blocked = () => editor.localBusy.value || editor.loading.value
  const begin = () => {
    editor.localBusy.value = true
    editor.localError.value = ''
    editor.localNotice.value = ''
  }
  const showError = (cause: unknown, started: RevisionCursor) => {
    if (revisionDelivery(started, editor.cursor()) !== 'switched') editor.showLocalError(cause)
  }
  const cleanRecovery = async (id: string, started: RevisionCursor) => {
    try {
      await editor.clearRecovery(id)
    } catch {
      if (revisionDelivery(started, editor.cursor()) !== 'switched')
        editor.localNotice.value +=
          ' Копию восстановления удалить не удалось — её можно удалить в разделе «Проекты».'
    }
  }

  async function save(copy: boolean): Promise<void> {
    const scheme = editor.imported.value?.scheme
    if (!scheme || editor.editorDirty.value || blocked()) return
    const cursor = editor.cursor()
    const recoveryId = editor.recoveryId()
    begin()
    try {
      const result = await SaveProjectRevision(
        repository,
        {
          scheme,
          expectedRevision: editor.localRevision.value ?? 0,
          cursor,
          ...(copy
            ? { copy: { id: crypto.randomUUID(), createdAt: new Date().toISOString() } }
            : {}),
        },
        editor.cursor,
      )
      // Another microtask can edit or switch sessions after the workflow returns.
      const delivery = revisionDelivery(cursor, editor.cursor())
      editor.projectsRefreshKey.value++
      if (delivery === 'switched') return
      if (copy) {
        if (delivery === 'edited') {
          editor.localNotice.value =
            'Отдельная копия сохранена в «Мои проекты». Более новые правки остались в открытом исходном проекте; сохраните их отдельно.'
          return
        }
        editor.beginSession()
        editor.imported.value = { ...editor.imported.value!, scheme: result.record.scheme }
        editor.history.value = startHistory(result.record.scheme)
        editor.selectedFileName.value = `Сохранённый проект · версия ${result.record.revision}`
        editor.localNotice.value =
          'Создана отдельная копия проекта — она появилась в «Мои проекты».'
      } else {
        editor.localNotice.value = `Проект сохранён на этом компьютере (версия ${result.record.revision}). Он есть в списке «Мои проекты».`
        if (delivery === 'edited')
          editor.localNotice.value +=
            ' Более новые правки остались открытыми; сохраните их отдельно.'
      }
      editor.localRevision.value = result.record.revision
      editor.modifiedSinceLocalSave.value = delivery === 'edited'
      if (delivery === 'current') await cleanRecovery(recoveryId, editor.cursor())
    } catch (cause) {
      showError(cause, cursor)
    } finally {
      editor.localBusy.value = false
    }
  }

  async function restoreLocal(id: string, sourceRevision: number, expectedRevision: number) {
    if (
      blocked() ||
      editor.imported.value?.scheme.id !== id ||
      editor.localRevision.value !== expectedRevision
    )
      return
    if (
      !window.confirm(
        `Вернуться к версии ${sourceRevision}? Она сохранится как новая версия проекта. Несохранённые правки в открытой вкладке будут заменены; текущая версия останется в списке версий.`,
      )
    )
      return
    const cursor = editor.cursor()
    begin()
    try {
      if (editor.hasUnsavedWork.value && !(await editor.flushRecovery())) return
      if (revisionDelivery(cursor, editor.cursor()) !== 'current') {
        if (revisionDelivery(cursor, editor.cursor()) === 'edited')
          editor.localNotice.value = 'Правки изменились; подтвердите возврат к версии заново.'
        return
      }
      const result = await RestoreProjectRevision(
        repository,
        { id, sourceRevision, expectedRevision, cursor },
        editor.cursor,
      )
      // Another microtask can edit or switch sessions after the workflow returns.
      const delivery = revisionDelivery(cursor, editor.cursor())
      editor.projectsRefreshKey.value++
      if (delivery === 'switched') return
      if (delivery === 'current')
        editor.openProjectRecord(result.record.scheme, result.record.revision)
      else {
        editor.localRevision.value = result.record.revision
        editor.modifiedSinceLocalSave.value = true
      }
      editor.localNotice.value = `Проект возвращён к версии ${sourceRevision} и сохранён как версия ${result.record.revision}.`
      if (delivery === 'edited')
        editor.localNotice.value +=
          ' Более новые правки остались открытыми; сохраните их отдельно или откройте восстановленную версию из «Мои проекты».'
    } catch (cause) {
      showError(cause, cursor)
    } finally {
      editor.localBusy.value = false
    }
  }

  return { saveLocally: () => save(false), saveAsNew: () => save(true), restoreLocal }
}
