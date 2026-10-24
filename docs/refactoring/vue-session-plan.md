# Контракт и план разделения Vue-сессии

Связанная задача: #136. Блок 136.1 фиксирует существующее поведение перед структурными изменениями. Исходная точка — `main` коммита `6ccd2a15816abab6312198c52e76bd552c0ae1b4` от 24.10.2026.

136.1 (#180) и 136.2 (#181) включены в main. 136.3 (#182) переносит HTTP в сервисы, запрещает прямой `fetch` в компонентах/composables и вводит `exportCurrentProject` / `exportOriginalProject`; прежние имена временно сохранены. 136.4 выделяет `useProjectDocument`, `useProjectHistory` и `useEditorDraftState`: состояние документа, историю и неприменённый ввод. Открытие/очистка и `commitScheme` координируют изменение согласованных refs; undo/redo восстанавливают собственные снимки PNG без повторного снятия закреплений. Таймеры, recovery и сохранение в этом переносе не перестраиваются. 136.5 выделяет восстановление, события окна и persistence; следующий блок — 136.6. [Сверка аудита и критерии технического этапа](audit-2026-10-24.md).

Этот документ не объявляет разделение выполненным. Он описывает текущий публичный контракт, инварианты и порядок небольших последующих PR. PR #163 и приёмка И3 не входят в эту работу.

## Текущая ответственность

После 136.5 восстановление координирует `useProjectRecovery` через переданные repository/list/snapshot и источники изменений. Модуль не меняет открытый документ и тестируется без монтирования компонента или браузера. Application-очередь `RecoverySession` сохранена. `useBrowserLifecycle` подписывает окно и снимает подписки при размонтировании; `useSessionCursor` синхронно учитывает ввод до следующего render batch. `useProjectPersistence` добавляет открытие локального проекта к существующим `useProjectRevisionActions`, используя тот же lock и callbacks документа.

Фасад по-прежнему связывает снимок форм, открытие восстановленной копии и уведомления. Команды шаблона/PNG и файловые действия остаются следующими блоками; полное упрощение ещё не завершено. Операции записи и возврата, число очередей, lease 120 с, heartbeat 20 с и debounce 800 мс не менялись. Следующий блок — 136.6, затем 136.7 и отдельная #134.

`useProjectSession` создаётся один раз в `App.vue` и объединяет:

```text
открытый документ и предупреждения импорта
├── импорт и экспорт JSON
├── создание проекта из карточки ПУ-66
├── неприменённый ввод и dirty-state
├── история undo/redo
├── выбранный объект
├── локальные редакции и оптимистичная конкурентность
├── recovery, владелец окна и browser lifecycle
├── сборка и автоматическая перестройка шаблона
├── закрепление редакций PNG
├── привязка карточки ПУ-66
└── сообщения и занятость операций
```

Сохранение и возврат редакций уже вынесены в `src/application/project-revisions.ts` и `useProjectRevisionActions`. Очередь recovery находится в `RecoverySession`; таймеры и отображение состояния после 136.5 принадлежат `useProjectRecovery`, события окна — `useBrowserLifecycle`. Фасад соединяет снимки форм с этими адаптерами. Этот блок не дублирует существующие application-сценарии.

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

- `onFileSelected`, `saveV5`, `saveOriginal`, `createProject`;
- `openLocal`, `saveLocally`, `saveAsNew`, `restoreLocal`;
- `localRevision`, `localBusy`, `localError`, `localNotice`, `projectsRefreshKey`.

Имя `saveV5` историческое: команда экспортирует текущий JSON v10. Переименование выполняется отдельно от переноса документа и не должно менять момент или результат экспорта.

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

## Порядок следующих блоков

1. **136.2 — ошибки API.** Коды вместо поиска текста в UI; учесть существующий `ProjectRevisionError`, маршруты и payload не менять. Реализовано в отдельном зависимом PR: `LocalApiError` и `localApiErrorCode` классифицируют ошибки адаптера и существующего revision workflow; преобразование прежнего текста конфликта остаётся только в сервисной границе. Специализированный `ParameterRequestError`, прямые запросы и остальные сервисы не изменяются до 136.3.
2. **136.3 — HTTP-адаптеры и имена.** Убрать прямые запросы из `App.vue` и `pinCurrentSigns`; отдельно сохранить совместимость при переименовании `saveV5`.
3. **136.4 — документ и история.** Выделить состояние документа, dirty-state и единый путь применения изменений; recovery не перестраивать.
4. **136.5 — recovery и persistence.** Отделить browser lifecycle, таймеры и session cursor. Поведение после сна не менять: это отдельная задача #134.
5. **136.6 — шаблон и PNG.** Перенести команды после стабилизации документа, истории и ошибок.
6. **136.7 — фасад.** Упростить координацию и документацию; внешний контракт менять только отдельным согласованным решением.

На всех блоках сохраняются JSON v10, SQLite v13, серверные маршруты, SVG, нормативные алгоритмы, workflow и публичный `ProjectSession`.

## Критерии отката

PR откатывается целиком, если меняется хотя бы один зафиксированный инвариант без отдельного предметного решения, появляется вторая сессия/история/recovery для одного окна, теряется неприменённый ввод, запоздалый ответ применяется к другой сессии либо меняются JSON, рисунок, отпечатки проверок или печать A4.

Обязательные проверки каждого последующего PR:

```bash
npm run check
npm run test:e2e
```

Откат не выполняют через обновление golden snapshots или ослабление characterization tests. Расхождение сначала объясняется и устраняется в переносимой реализации.
