# Контракт и план разделения Vue-сессии

> **Исторический материал.** Перенесён 29.10.2026 из `docs/refactoring/vue-session-plan.md`; исходный срез — [4f3acd6](https://github.com/hhypest/editor-of-tod/blob/4f3acd687bdf09c8063a03cb8e52f46d6f751885/docs/refactoring/vue-session-plan.md), последнее изменение исходника — 2026-10-25 6c46614. Даты, форматы, результаты и «следующие шаги» в тексте относятся к описываемому этапу. [Текущее описание](../../engineering/state-and-recovery.md) · [Текущая очередь](../../../ROADMAP.md) · [Каталог](../../catalog.md).

Связанная задача: #136. Исходная точка characterization tests — `main` коммита `6ccd2a15816abab6312198c52e76bd552c0ae1b4` от 24.10.2026. Блоки 136.1–136.6 включены через #180–#183, #186 и #187; 136.7 завершает структурную композицию. [Предметная сверка 0.3.0](../../verification/0.3.0/README.md) и отдельное поведение после сна #134 этим переносом не закрываются.

## Компонование одной сессии

```text
useProjectSession — один фасад на окно
├── useProjectDocument — документ и согласованное применение схемы
├── useProjectHistory — одна история undo/redo
├── useEditorDraftState — неприменённый ввод и seed восстановления
├── useSessionCursor — синхронная версия сессии/правок
├── useProjectRecovery — снимки, debounce и heartbeat поверх RecoverySession
├── useBrowserLifecycle — подписки и снятие подписок окна
├── useProjectPersistence — открытие и прежние save/restore workflows
├── useTemplateActions — шаблон, уведомления, выбор объекта и PinProjectSigns
├── useProjectFiles — чтение/экспорт JSON и создание из ПУ-66
└── useRecoveryActions — подтверждение и открытие захваченной копии, ввод после nextTick
```

Фасад соединяет адаптеры и источники данных, а не создаёт вторую очередь, историю или документ. DOM-скачивание выполняет `services/project-download.ts`; глобальные window/document/fetch и таймеры в фасаде запрещены ESLint. Предметные расчёты, миграции формата и построение шаблона остаются в прежних чистых domain-функциях.

`RecoverySession`, `SaveProjectRevision` и `RestoreProjectRevision` сохранены. `PinProjectSigns` получает каталог через узкий порт; после его Promise UI повторно проверяет снимок непосредственно перед применением. Локальное чтение использует прежний lock, а запись и возврат — прежние курсоры и классификацию доставки. Recovery тестируется без монтирования компонента и браузера, browser lifecycle — отдельно на реальном lifecycle Vue.

Внешний `ProjectSession` сохранён. 44 публичных ключа и тождественность совместимых команд экспорта закреплены тестом, снятым до последнего переноса. `saveV5` и `saveOriginal` остаются deprecated-псевдонимами `exportCurrentProject` и `exportOriginalProject`; продукт использует семантические имена. Удаление псевдонимов потребует отдельного изменения контракта.

JSON v10, SQLite v13, URL, SVG, нормативные отпечатки, debounce 800 мс, heartbeat 20 с и lease 120 с не менялись. Структурное завершение #136 не означает исправления #134, общей декомпозиции сервера #135 или завершения пользовательского интерфейса.

## Публичный контракт `ProjectSession`

Тип `ProjectSession` — `ReturnType<typeof useProjectSession>`. До завершения переноса имена, реактивность и смысл возвращаемых refs и команд сохраняются. Дочерние представления не создают собственную сессию.

### Состояние документа и форм

- `imported`, `selectedFileName`, `errorMessage`, `loading`;
- `detailsDirty`, `placementDirty`, `editorDirty`, `hasUnsavedWork`;
- `modifiedSinceLocalSave`, `selectedPlacementId`;
- `pendingDetails`, `pendingPlacement`, `recoverySeed`.

### История и команды документа

- `history`;
- `onProjectApplied`, `onDetailsApplied`, `onPu66Linked`;
- `stepBack`, `stepForward`;
- `buildDraftTemplate`, `pinCurrentSigns`;
- `templateMessage`, `templateError`, `signPinMessage`.

### Файлы и локальные проекты

- `onFileSelected`, `exportCurrentProject`, `exportOriginalProject`, `createProject`;
- совместимые `saveV5`, `saveOriginal`;
- `openLocal`, `saveLocally`, `saveAsNew`, `restoreLocal`;
- `localRevision`, `localBusy`, `localError`, `localNotice`, `projectsRefreshKey`.

Исторические псевдонимы экспортируют тот же текущий JSON v10 и исходный v1. Момент и результат экспорта сохранены; скачивание не подтверждает запись в базу и не удаляет recovery.

### Recovery

- `recoveryCopies`, `activeRecoveryId`, `recoveryStatus`;
- `openRecovery`, `discardRecovery`.

## Потребители контракта

- `App.vue` создаёт единственную сессию; использует документ, dirty-state, локальную занятость, сообщения, recovery status и `saveLocally`.
- `ProjectHub.vue` получает существующую сессию целиком; использует открытие/создание проектов, локальные редакции и recovery.
- `EditorWorkspace.vue` получает ту же сессию целиком; использует документ, формы, историю, экспорт, шаблон, PNG и выбор объекта.
- `useEditorNavigation` получает только `imported` и `placementDirty`, но не владеет документом.
- `src/composables/__tests__/useProjectSession.test.ts` проверяет реальный Vue lifecycle и публичные refs/команды.

Переход на узкие props или отдельные session-фасады не входит в 136.1. Он допустим только после сохранения поведения существующих потребителей.

## Зависимости

- Предметная модель: `Scheme`, импорт/экспорт, `edit-history`, шаблоны, закрепление PNG.
- Application: `SaveProjectRevision`, `RestoreProjectRevision`, `RecoverySession` и их узкие интерфейсы.
- Адаптеры: `src/services/local-projects.ts`, диагностика, нормативные правила.
- Vue: refs, computed, watchers и lifecycle текущего окна.
- Браузер: File/Blob/URL, подтверждения, `beforeunload`, `pagehide`, `pageshow`, `visibilitychange`, таймеры и `crypto.randomUUID`.
- После 136.3 запросы `/api/signs` и `/api/signs/catalog` выполняет `loadSignCatalogSnapshot` в `src/services/local-signs.ts`; проверка неизменности проекта остаётся в команде закрепления. HTTP отсутствует и в остальных компонентах; прежние URL и лимиты выборок сохранены.

## Инварианты и защитные проверки

| Инвариант                                                                                         | Проверка                                                                   |
| ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Применённая правка создаёт один элемент истории; undo/redo восстанавливает соответствующие снимки | `records one applied change as one undo step and restores it with redo`    |
| Перестройка шаблона после правки этапа 2 входит в то же действие истории                          | `rebuilds a built template on stage 2 edits…`                              |
| Смена проекта очищает сообщения и начинает новую историю                                          | `clears project-scoped messages when another JSON project is opened`       |
| Обычное сохранение не заменяет открытую схему и не сбрасывает undo/redo                           | `acknowledges a save without replacing…`                                   |
| Повторная запись неизменённой схемы не добавляет редакцию                                         | `acknowledges a repeated save…`                                            |
| Неприменённый ввод запрещает сохранение и экспорт; повторная concurrent-запись не запускается     | `does not save unapplied input…`, `does not download the current project…` |
| Конфликт сохраняет документ, ввод, базовую редакцию и историю; автоматического повтора нет        | `preserves state on a save conflict…`                                      |
| Ответ старой сессии не изменяет новый проект, включая повторное открытие того же id               | `does not apply a late save revision…`, `ignores a late…`                  |
| Правки и ввод во время сохранения/возврата остаются открытыми                                     | `keeps newer edits…`, `keeps input started during a save…`                 |
| Изменение ввода во время предварительной recovery-записи отменяет ещё не отправленный возврат     | `does not restore after input changes…`                                    |
| Успешный текущий возврат начинает новую историю                                                   | `opens a current restored revision…`                                       |
| Ошибка удаления recovery не становится ошибкой уже сохранённой редакции                           | `does not report recovery cleanup failure…`                                |
| Запоздалый ответ каталога не закрепляет PNG в изменённом проекте                                  | `does not pin a sign catalog response…`                                    |
| Экспорт файла не подтверждает запись в базу и не удаляет recovery                                 | Группа `JSON export does not acknowledge a database save`                  |
| Потеря владельца recovery сохраняет открытые правки и предупреждение закрытия                     | `retains open edits and the unload warning…`                               |
| `pagehide` освобождает владельца без новой записи снимка                                          | `releases the owner on pagehide…`                                          |

Application-тесты отдельно фиксируют классификацию `current` / `edited` / `switched`, валидацию ответа и отсутствие повтора конфликта. SQLite/API и e2e остаются обязательными: модульные тесты не заменяют реальную конкурентную запись, печать A4 и браузерный lifecycle.

## Выполненная последовательность блоков

1. **136.2 — ошибки API.** Коды вместо поиска текста в UI; учесть существующий `ProjectRevisionError`, маршруты и payload не менять. Реализовано в отдельном зависимом PR: `LocalApiError` и `localApiErrorCode` классифицируют ошибки адаптера и существующего revision workflow; преобразование прежнего текста конфликта остаётся только в сервисной границе. Специализированный `ParameterRequestError`, прямые запросы и остальные сервисы не изменяются до 136.3.
2. **136.3 — HTTP-адаптеры и имена.** Убрать прямые запросы из `App.vue` и `pinCurrentSigns`; отдельно сохранить совместимость при переименовании `saveV5`.
3. **136.4 — документ и история.** Выделить состояние документа, dirty-state и единый путь применения изменений; recovery не перестраивать.
4. **136.5 — recovery и persistence.** Отделить browser lifecycle, таймеры и session cursor. Поведение после сна не менять: это отдельная задача #134.
5. **136.6 — шаблон и PNG.** Перенести команды после стабилизации документа, истории и ошибок.
6. **136.7 — фасад.** Упростить координацию и документацию; внешний контракт менять только отдельным согласованным решением.

На всех блоках сохраняются JSON v10, SQLite v13, серверные маршруты, SVG, нормативные алгоритмы, workflow и публичный `ProjectSession`.

## Критерии отката

PR откатывается целиком, если меняется хотя бы один зафиксированный инвариант без отдельного предметного решения, появляется вторая сессия/история/recovery для одного окна, теряется неприменённый ввод, запоздалый ответ применяется к другой сессии либо меняются JSON, рисунок, отпечатки проверок или печать A4.

Обязательные проверки структурных изменений:

```bash
npm run check
npm run test:e2e
```

Откат не выполняют через обновление golden snapshots или ослабление characterization tests. Расхождение сначала объясняется и устраняется в переносимой реализации.
