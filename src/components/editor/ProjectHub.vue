<script setup lang="ts">
import { computed } from 'vue'
import { storeToRefs } from 'pinia'
import { useProjectDocumentStore } from '../../stores/project-document'
import { useProjectSessionUiStore } from '../../stores/project-session-ui'
import { useEditorNavigationStore } from '../../stores/editor-navigation'
import NewScheme from '../NewScheme.vue'
import LocalProjects from '../LocalProjects.vue'
import FirstRunWizard from '../FirstRunWizard.vue'
import type { ProjectHubCommands } from '../../composables/project-view-commands'
import type { ProjectTab, SetupImportTarget } from '../../presentation/editor-navigation'
import type { FirstRunStatus } from '../../presentation/first-run'
const props = defineProps<{
  commands: ProjectHubCommands
  setupStatus: FirstRunStatus | null
  setupError: string
}>()
const emit = defineEmits<{
  'open-setup': []
  'choose-tab': [tab: ProjectTab]
  'setup-import': [target: SetupImportTarget]
  help: [section: string]
}>()
// Reading shared state never constructs the session or its recovery workflow.
const { imported, editorDirty, loading, localRevision, errorMessage } =
  storeToRefs(useProjectDocumentStore())
const { recoveryCopies, activeRecoveryId, localBusy, projectsRefreshKey } = storeToRefs(
  useProjectSessionUiStore(),
)
const { projectTab, activeView } = storeToRefs(useEditorNavigationStore())
const active = computed(() => activeView.value === 'projects')
const { openRecovery, discardRecovery, createProject, openLocal, restoreLocal, onFileSelected } =
  props.commands
</script>

<template>
  <section class="view" aria-labelledby="projects-heading">
    <div class="view-heading">
      <p class="eyebrow">Рабочее место</p>
      <h1 id="projects-heading">Проекты схем</h1>
      <p>
        Продолжите сохранённый проект, начните новую схему по карточке ПУ-66 или откройте файл
        проекта, полученный от коллеги или из прежней версии программы.
      </p>
    </div>
    <section v-if="recoveryCopies.length" class="module" aria-labelledby="recovery-heading">
      <h2 id="recovery-heading">Копии восстановления</h2>
      <p class="hint">
        Здесь остаются правки, которые не успели сохранить до закрытия окна. Копия хранится на этом
        компьютере отдельно от сохранённых версий проекта.
      </p>
      <ul>
        <li v-for="copy in recoveryCopies" :key="copy.sessionId">
          <strong>{{ copy.referenceId }}</strong> · {{ copy.fileName }} ·
          {{ new Date(copy.updatedAt).toLocaleString('ru-RU') }}
          <span v-if="copy.sessionId === activeRecoveryId"> · открыта сейчас</span>
          <span v-else-if="copy.active"> · открыта в другом окне</span>
          <button
            type="button"
            :disabled="localBusy || loading || copy.active"
            @click="openRecovery(copy.sessionId)"
          >
            Восстановить
          </button>
          <button
            type="button"
            :disabled="localBusy || copy.active || copy.sessionId === activeRecoveryId"
            @click="discardRecovery(copy.sessionId, copy.version)"
          >
            Удалить копию
          </button>
        </li>
      </ul>
    </section>
    <FirstRunWizard
      v-if="setupStatus"
      :status="setupStatus"
      :locked="editorDirty || localBusy || loading"
      @open="emit('open-setup')"
    />
    <p v-if="setupError" class="feedback error" role="alert">{{ setupError }}</p>
    <div class="tabs" role="group" aria-label="Способ открытия проекта">
      <button
        type="button"
        :aria-pressed="projectTab === 'local'"
        @click="emit('choose-tab', 'local')"
      >
        Мои проекты
      </button>
      <button type="button" :aria-pressed="projectTab === 'new'" @click="emit('choose-tab', 'new')">
        Новый проект
      </button>
      <button
        type="button"
        :aria-pressed="projectTab === 'file'"
        @click="emit('choose-tab', 'file')"
      >
        Открыть файл
      </button>
    </div>
    <NewScheme
      v-show="projectTab === 'new'"
      class="module"
      :locked="localBusy || loading"
      :active="projectTab === 'new' && active"
      @create="createProject"
      @import-pu66="emit('setup-import', 'pu66-import')"
    />
    <LocalProjects
      v-if="projectTab === 'local'"
      class="module"
      :active-id="imported?.scheme.id ?? null"
      :active-revision="localRevision"
      :refresh-key="projectsRefreshKey"
      :locked="localBusy || loading"
      @open="openLocal"
      @restore="restoreLocal"
      @create="emit('choose-tab', 'new')"
    />
    <section v-show="projectTab === 'file'" class="module" aria-labelledby="import-title">
      <h2 id="import-title">Открыть файл проекта</h2>
      <label for="scheme-file" class="file-label">Файл проекта с вашего компьютера</label>
      <input
        id="scheme-file"
        type="file"
        accept=".json,application/json"
        :disabled="localBusy"
        @change="onFileSelected"
      />
      <p class="hint">
        Файл проекта скачивается кнопкой «Скачать файл проекта». Подходят файлы текущей и прежних
        версий программы размером до 32 МБ. Открытый файл не попадает в «Мои проекты», пока вы не
        нажмёте «Сохранить проект».
      </p>
      <p v-if="loading" class="hint" role="status">Проверяем файл…</p>
      <p v-if="errorMessage" class="error" role="alert">{{ errorMessage }}</p>
    </section>
  </section>
</template>

<style scoped src="../../styles/editor-common.css" />
<style scoped src="../../styles/ProjectHub.css" />
