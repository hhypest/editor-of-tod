# Состояние редактора и восстановление

Тип: действующая справка; актуальная реализация и ограничения.

Действующая карта для разработчика. Сверено 01.11.2026 по main 6974c7e и ручному редактору примыканий. Причины выбора — [ADR-0011](../adr/0011-pinia-ui-state.md), устройство целиком — [архитектура](architecture.md). Очередь изменений задаёт [ROADMAP](../../ROADMAP.md).

## Где живут данные

В [main.ts](../../src/main.ts) создаётся одна Pinia на Vue app. [App.vue](../../src/App.vue) создаёт одну корневую сессию `useProjectSession` на окно. Получение store не создаёт вторую сессию; независимые app имеют независимые stores.

| Владелец                                                     | Данные и ответственность                                                                                 | Что остаётся у адаптера                                                                         |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| [project-document](../../src/stores/project-document.ts)     | Открытый документ, история undo/redo, выбранный объект, modified/revision, dirty/pending и recovery seed | Применение документа, история и ввод — useProjectDocument/useProjectHistory/useEditorDraftState |
| [project-session-ui](../../src/stores/project-session-ui.ts) | Busy/error/notice, сообщения шаблона и PNG, список/status/id recovery, счётчик обновления проектов       | HTTP, команды, очередь и таймеры recovery — корневая сессия и её адаптеры                       |
| [editor-navigation](../../src/stores/editor-navigation.ts)   | Представление, вкладки, выбранная вкладка, раздел справки и уведомление о находке                        | useEditorNavigation: DOM focus/scroll, nextTick, lifecycle и стартовый запрос                   |
| [catalog-refresh](../../src/stores/catalog-refresh.ts)       | Версии каталогов знаков и ПУ-66                                                                          | Корневые обработчики обновления, invalidation/reload                                            |
| [normative-rules](../../src/stores/normative-rules.ts)       | Состояния нормативных параметров, rules/loading/error, один выполняющийся reload на app                  | Существующий HTTP-сервис; чтение store само не запускает reload                                 |
| [pu66-status](../../src/stores/pu66-status.ts)               | Ответы статуса по ключам, версия invalidation, объединение запросов одного ключа                         | usePu66Status связывает чтение с Vue lifecycle; callback захватывает конкретный store           |

ProjectHub, RegistryHub и EditorWorkspace читают общие данные через `storeToRefs`. Узкие [порты команд](../../src/composables/project-view-commands.ts) собираются в корне из методов единственной сессии. Формы сохраняют локальный ввод; pending-поля служат проекцией для восстановления, а не второй историей документа. Общий `$reset`, сериализация stores и синхронизация двух копий через watchers не вводились.

Setup open/status/error, startup request и отложенный setup в sessionStorage остаются в App: ими владеет один мастер. Domain/application не импортируют stores, Vue или Pinia; ограничения описаны в [карте архитектурных запретов](architecture-guards.md).

У примыканий отдельные `selectedRoadNodeId`, `roadNodeDirty`, `pendingRoadNode` в том же владельце документа; они не смешиваются с IDs и вводом стоек. `RoadNodeEditor` передаёт команды через существующий onProjectApplied и общую историю. Пока одна форма содержит неприменённый ввод, остальные редакторы блокируются, а editorDirty учитывает все три вида ввода.

Рабочая копия использует прежний object slot `placementDraft` / `placement_json`: к старым вариантам добавлен явный `kind: road-node`. `useRecoveryActions` разделяет формы и пространства ID при восстановлении. Схема проекта остаётся v12, SQLite — v13; новые таблицы/таймеры/очереди не создаются. Невалидное или пустое расстояние допустимо в копии ввода, но не в применённом узле. Необязательная строка sheetOffsetXSvg хранит ввод условного отступа: пустая строка применяется как null, отсутствие в прежней рабочей форме сохраняет применённый отступ. Рисунок/его замечания производны от применённой схемы и не добавляются в рабочую копию отдельным состоянием. Курсор и наблюдение recovery включают новые dirty/pending refs, защищая ввод от поздних ответов и сохраняя его при повторе после online.

## Одна очередь и защита поздних ответов

[RecoverySession](../../src/application/recovery-session.ts) последовательно выполняет запись снимков и смену владения через узкий RecoveryRepository. Она не знает Vue, HTTP, SQLite, таймеры и browser globals. [useProjectRecovery](../../src/composables/useProjectRecovery.ts) соединяет её со снимком документа, debounce 800 мс и heartbeat 20 с; аренда владельца — 120 с. Значения lease/heartbeat определены в application-модуле, а не в store.

Курсор сессии и generation проверяются после асинхронных операций. Новый ввод во время записи остаётся pending до своей записи; ответ прежней сессии не помечает новую сохранённой. После await команды используют захваченные refs конкретного app, даже если active Pinia уже другая. Save/restore используют общий operation lock и курсоры; конфликт или ошибка сохраняет открытый документ, историю и неприменённый ввод. Команды PNG также повторно проверяют снимок перед применением результата.

При invalidation ПУ-66 во время запроса store повторяет чтение до ответа при неизменной версии. Пока повтор не окончен, loading и блокировка отметки не позволяют использовать промежуточный статус для выпуска. Ошибка старого запроса не отменяет необходимость повторного чтения.

## Жизненный цикл и два окна

[useBrowserLifecycle](../../src/composables/useBrowserLifecycle.ts) владеет подписками окна/видимости. Размонтирование инвалидирует курсор, снимает listeners, останавливает таймеры и освобождает свою копию. `pagehide` освобождает известное владение без новой записи снимка. Ошибка heartbeat сохраняет правки и предупреждение закрытия. Поведение после сна и восстановления сети проверяется отдельно от простой подмены времени в unit-тесте.

Серверные owner/version/lease и source проверяются в атомарной команде [RecoveryRepository](../../server/recovery/recovery-repository.ts). Истёкшая аренда сама по себе не разрешает запись другому окну: нужен claim. После takeover старый владелец не может продолжить запись, в том числе после release новым владельцем. Подробности блокировок — [сервер и хранение](server-and-storage.md#проекты-исходный-json-и-recovery).

## Защитные проверки

| Граница                                      | Где проверять                                                                                                                                                                                                                                    |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Одна application-очередь, версии и исходник  | [recovery-session.test.ts](../../src/application/__tests__/recovery-session.test.ts)                                                                                                                                                             |
| Pending, debounce, late response и lifecycle | [project-recovery](../../src/composables/__tests__/project-recovery.test.ts), [browser-lifecycle](../../src/composables/__tests__/browser-lifecycle.test.ts), [project-persistence](../../src/composables/__tests__/project-persistence.test.ts) |
| Совместимая сессия, refs и разные app        | [useProjectSession](../../src/composables/__tests__/useProjectSession.test.ts), [project-document](../../src/composables/__tests__/project-document.test.ts), [project-session-ui](../../src/composables/__tests__/project-session-ui.test.ts)   |
| Читатели представлений без второй сессии     | [store-consumers.test.ts](../../src/components/editor/__tests__/store-consumers.test.ts)                                                                                                                                                         |
| Invalidation и ответы ПУ-66                  | [usePu66Status.test.ts](../../src/composables/__tests__/usePu66Status.test.ts)                                                                                                                                                                   |
| Конкуренция окон и аренда                    | [recovery-ownership](../../server/__tests__/recovery-ownership.test.ts), [recovery-repository](../../server/__tests__/recovery-repository.test.ts), [браузерные сценарии](../../tests/e2e/editor.spec.ts)                                        |

Совместимые `saveV5`/`saveOriginal` остаются deprecated aliases; удаление требует отдельного изменения контракта. Проверки структурных изменений не подменяют предметную приёмку. Последний завершённый технический протокол — [28.10.2026](../verification/reports/2026-10-28-technical-regression.md); история переноса — в [каталоге архива](../catalog.md#история-технических-переносов).

Ручная связь стойки использует необязательный roadLink внутри существующей формы sign-post. Подкомпонент полей не создаёт сессию; dirty/pending и cursor остаются у PlacementEditor и существующего владельца документа. Незавершённый замер (например, «-») восстанавливается как ввод, без изменения применённых links/installation. Прежние формы без roadLink сохраняют связь из проекта.

Ручное размещение стойки на ветви использует необязательный branchPlacement внутри roadLink существующей формы sign-post. Выбор ветви, строки условных отступов (включая незавершённый минус) и поворот восстанавливаются до применения без изменения модели. Применение записывает объект и связь одной операцией общей истории; движения меняют только условные координаты связи, метры сохраняются. Применённый формат — JSON v13 / SQLite v13; новых владельцев, очередей и таблиц нет. Старые формы без этого поля сохраняют текущее размещение; отключение делается явно. [Контракт](../adr/0013-branch-post-placement.md).
