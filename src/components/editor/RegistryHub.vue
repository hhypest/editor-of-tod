<script setup lang="ts">
import DiagnosticsPanel from '../DiagnosticsPanel.vue'
import LocalRegistries from '../LocalRegistries.vue'
import ImportedData from '../ImportedData.vue'
import NormativeDocuments from '../NormativeDocuments.vue'
import NormativeParameters from '../NormativeParameters.vue'
import Pu66Lifecycle from '../Pu66Lifecycle.vue'
import type { Scheme } from '../../domain/model'
import type { EditorView, RegistryTab } from '../../presentation/editor-navigation'
defineProps<{
  scheme: Scheme | null
  view: EditorView
  registryTab: RegistryTab
  editorDirty: boolean
  localBusy: boolean
  referencedSignIds: string[]
  signCatalogVersion: number
  pu66CatalogVersion: number
}>()
const emit = defineEmits<{
  'choose-tab': [tab: RegistryTab]
  'signs-updated': []
  'pu66-updated': []
}>()
</script>

<template>
  <section class="view" aria-labelledby="registries-heading">
    <div class="view-heading">
      <p class="eyebrow">Отдельный раздел</p>
      <h1 id="registries-heading">Локальные реестры</h1>
      <p>
        Карточки ПУ-66, каталог знаков и нормативные документы остаются в базе на этом компьютере.
      </p>
    </div>
    <div class="tabs" role="group" aria-label="Раздел реестров">
      <button
        type="button"
        :aria-pressed="registryTab === 'imports'"
        @click="emit('choose-tab', 'imports')"
      >
        Импорт Excel и знаков
      </button>
      <button
        type="button"
        :aria-pressed="registryTab === 'documents'"
        @click="emit('choose-tab', 'documents')"
      >
        Нормативные документы
      </button>
      <button
        type="button"
        :aria-pressed="registryTab === 'parameters'"
        @click="emit('choose-tab', 'parameters')"
      >
        Нормативные параметры
      </button>
      <button
        type="button"
        :aria-pressed="registryTab === 'entries'"
        @click="emit('choose-tab', 'entries')"
      >
        Карточки и нормативы
      </button>
      <button
        type="button"
        :aria-pressed="registryTab === 'diagnostics'"
        @click="emit('choose-tab', 'diagnostics')"
      >
        Диагностика
      </button>
    </div>
    <ImportedData
      v-show="registryTab === 'imports'"
      class="module"
      :referenced-sign-ids="referencedSignIds"
      :locked="editorDirty"
      :refresh-key="signCatalogVersion + pu66CatalogVersion"
      @signs-updated="emit('signs-updated')"
      @pu66-updated="emit('pu66-updated')"
    />
    <NormativeDocuments
      v-if="registryTab === 'documents'"
      class="module"
      :locked="editorDirty"
      @changed="emit('signs-updated')"
    />
    <NormativeParameters
      v-if="registryTab === 'parameters'"
      class="module"
      :refresh-key="signCatalogVersion"
    />
    <Pu66Lifecycle
      v-show="registryTab === 'entries'"
      class="module"
      :locked="localBusy"
      :refresh-key="pu66CatalogVersion"
      @changed="emit('pu66-updated')"
    />
    <LocalRegistries v-show="registryTab === 'entries'" class="module" />
    <DiagnosticsPanel
      v-if="registryTab === 'diagnostics'"
      class="module"
      :scheme="scheme"
      :view="view"
    />
  </section>
</template>

<style scoped src="../../styles/editor-common.css" />
<style scoped src="../../styles/RegistryHub.css" />
