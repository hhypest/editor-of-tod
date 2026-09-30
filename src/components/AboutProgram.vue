<script setup lang="ts">
import { onMounted, ref } from 'vue'
import licenseText from '../../LICENSE?raw'
import licenseRussian from '../../LICENSE.ru.md?raw'
import { appBuild } from '../services/diagnostics'

/**
 * Раздел справки «О программе и лицензии»: автор, лицензия MIT с переводом и список сторонних
 * компонентов из сборки (`legal/third-party.json`). Полные тексты их лицензий — в
 * `legal/THIRD_PARTY_LICENSES.txt`, тот же файл лежит рядом с exe.
 */
type ThirdParty = {
  groups: Array<{
    title: string
    packages: Array<{ name: string; version: string; license: string; homepage: string | null }>
  }>
  node: { version: string; license: string } | null
}

const components = ref<ThirdParty | null>(null)
const state = ref<'loading' | 'ready' | 'missing'>('loading')

onMounted(async () => {
  try {
    const response = await fetch('/legal/third-party.json')
    if (!response.ok) throw new Error('Нет сведений')
    components.value = (await response.json()) as ThirdParty
    state.value = 'ready'
  } catch {
    state.value = 'missing'
  }
})

/** Русский перевод без заголовка файла: в разделе справки заголовок уже есть. */
const russian = licenseRussian.replace(/^# .*\n+/, '')
</script>

<template>
  <div class="about">
    <dl class="facts">
      <dt>Программа</dt>
      <dd>
        Редактор схем организации дорожного движения на железнодорожных переездах (editor-of-tod)
      </dd>
      <dt>Версия</dt>
      <dd>
        {{ appBuild.version }}, сборка {{ appBuild.commit
        }}{{
          appBuild.builtAt ? ` от ${new Date(appBuild.builtAt).toLocaleDateString('ru-RU')}` : ''
        }}
      </dd>
      <dt>Автор и правообладатель</dt>
      <dd>Манченко Иван Григорьевич, 2026</dd>
      <dt>Лицензия</dt>
      <dd>
        MIT — свободное бесплатное использование, изменение и передача с сохранением уведомления об
        авторстве
      </dd>
      <dt>Исходный код</dt>
      <dd>github.com/hhypest/editor-of-tod</dd>
    </dl>

    <details class="license">
      <summary>Текст лицензии (неофициальный перевод и пояснения)</summary>
      <pre>{{ russian }}</pre>
    </details>
    <details class="license">
      <summary>Текст лицензии (оригинал, имеет юридическую силу)</summary>
      <pre lang="en">{{ licenseText }}</pre>
    </details>

    <h3>Сторонние компоненты</h3>
    <p class="hint">
      В программу входят свободные компоненты других авторов с лицензиями MIT, ISC, BSD и Apache
      2.0. Их условия разрешают бесплатное использование и требуют сохранять тексты лицензий — они
      собраны в файле THIRD_PARTY_LICENSES.txt рядом с программой.
    </p>
    <p v-if="state === 'loading'" class="hint" role="status">Читаю список компонентов…</p>
    <p v-else-if="state === 'missing'" class="hint">
      Список формируется при сборке программы. В режиме разработки он недоступен — выполните npm run
      build или откройте собранную программу.
    </p>
    <template v-else-if="components">
      <p>
        <a href="/legal/THIRD_PARTY_LICENSES.txt" target="_blank" rel="noopener"
          >Открыть полные тексты лицензий</a
        >
      </p>
      <details v-for="group in components.groups" :key="group.title" class="components">
        <summary>{{ group.title }} — {{ group.packages.length }}</summary>
        <table>
          <thead>
            <tr>
              <th>Компонент</th>
              <th>Версия</th>
              <th>Лицензия</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in group.packages" :key="`${item.name}@${item.version}`">
              <td>{{ item.name }}</td>
              <td>{{ item.version }}</td>
              <td>{{ item.license }}</td>
            </tr>
          </tbody>
        </table>
      </details>
      <p v-if="components.node" class="hint">
        Исполняемый файл содержит среду Node.js {{ components.node.version }} ({{
          components.node.license
        }}); её лицензия приведена в том же файле.
      </p>
    </template>
  </div>
</template>

<style scoped>
.facts {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 0.35rem 1rem;
  margin: 0 0 1rem;
}
.facts dt {
  font-weight: 600;
}
.facts dd {
  margin: 0;
}
.license pre {
  max-height: 24rem;
  overflow: auto;
  padding: 0.8rem;
  border: 1px solid #d8e1eb;
  border-radius: 0.35rem;
  background: #f7f9fb;
  font-family: inherit;
  font-size: 0.85rem;
  line-height: 1.45;
  white-space: pre-wrap;
}
details {
  margin: 0.5rem 0;
}
summary {
  cursor: pointer;
  font-weight: 600;
}
table {
  width: 100%;
  margin-top: 0.4rem;
  border-collapse: collapse;
  font-size: 0.85rem;
}
th,
td {
  padding: 0.25rem 0.5rem;
  border-bottom: 1px solid #e3e9ef;
  text-align: left;
}
.hint {
  color: #526273;
  font-size: 0.9rem;
  line-height: 1.5;
}
@media (max-width: 36rem) {
  .facts {
    grid-template-columns: 1fr;
  }
}
</style>
