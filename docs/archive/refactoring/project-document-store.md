# Документ, история и восстановимый ввод в Pinia (#191)

> **Исторический материал.** Перенесён 29.10.2026 из `docs/refactoring/project-document-store.md`; исходный срез — [4f3acd6](https://github.com/hhypest/editor-of-tod/blob/4f3acd687bdf09c8063a03cb8e52f46d6f751885/docs/refactoring/project-document-store.md), последнее изменение исходника — 2026-10-27 a81359c. Даты, форматы, результаты и «следующие шаги» в тексте относятся к описываемому этапу. [Текущее описание](../../engineering/state-and-recovery.md) · [Текущая очередь](../../../ROADMAP.md) · [Каталог](../../catalog.md).

Третий владелец после нормативных параметров (#228) и статусов ПУ-66 (#229, включён в main 0ba0b64). [ADR-0011](../../adr/0011-pinia-ui-state.md) · [план перехода](pinia-state-plan.md). Сохраняется одна сессия на окно; перенос меняет владельца refs. Зависимости и lockfile не меняются.

## Состояние и команды

`src/stores/project-document.ts` предоставляет один набор данных на app. Все реактивные поля возвращаются явно; импорт модуля и получение store не запускают рабочие операции.

| Данные                                                                           | Представление                                               | Прежний адаптер операций                                                 |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------ |
| imported, имя файла, error/loading, modified, localRevision, selectedPlacementId | shallowRef импортированного документа и прежние scalar refs | useProjectDocument: clear/open/commit/stepHistory                        |
| history                                                                          | shallowRef неизменяемых past/present/future                 | useProjectHistory: start/reset/record/step поверх прежних domain-функций |
| detailsDirty/placementDirty, pendingDetails/pendingPlacement, recoverySeed       | прежние ref/shallowRef, производный editorDirty             | useEditorDraftState: clearDirty/clearPending                             |

UseProjectSession получает storeToRefs один раз и явно передаёт этот набор document/history/draft-адаптерам. Адаптеры принимают узкие Pick-порты refs; без явного порта используют store текущего app. Их прежние имена, команды и возвращаемые поля сохраняются. Ранее созданные команды работают с захваченными refs даже после await/смены active Pinia. Root передаёт один набор всем трём адаптерам, поэтому сборка не зависит от повторного поиска активного store.

Store содержит данные и computed editorDirty. HTTP, cursor/generation, файл/скачивание, команды сохранения и восстановления, RecoverySession, её очередь, debounce/heartbeat и browser lifecycle остаются в существующих адаптерах/корневой сессии. Другой потребитель данных не создаёт useProjectSession. Local busy/error/notice, refresh/template/sign messages и recovery UI-проекция остаются следующим шагом; навигация следует отдельно.

## Сохранность и совместимость

AST-сверка подтверждает сохранение **14 инициализаторов и 10 тел команд**. Imported/history/pending/seed остаются shallow: применённая схема, исторические снимки и неприменённые draft-объекты сохраняют прежнюю идентичность. Vue deep proxies для этих значений не вводятся.

ClearDirty снимает флаги, сохраняя pending/seed; clearPending удаляет pending/seed, сохраняя dirty flags. ClearDocument очищает документ, историю, выбор и метаданные согласно прежнему телу, но не выполняет clearPending и не меняет loading. OpenDocument начинает историю, сохраняет переданные метаданные, снимает dirty flags, оставляя отдельные pending/error/loading. BeginSession в корне по-прежнему отдельно очищает pending. Общего `$reset` для этих операций не добавлено.

Commit сохраняет прежнюю согласованность схемы, снятия PNG pins, одной записи истории, dirty flags и modified. Undo/redo блокируются при editorDirty; исторические pins берутся из снимка без перерасчёта. Неприменённые формы не становятся применённой схемой автоматически. Локальные формы по-прежнему владеют своим вводом; pending/seed остаются прежней проекцией для восстановления.

Public ProjectSession сохраняет **44 ключа**, включая совместимые экспортные псевдонимы. Все прежние cursor guards, конфликт 409, поздние ответы, выбор проекта, wake/claim/save и JSON-экспорт проверяются теми же session/application/API/E2E сценариями. Форматы JSON v10/SQLite v13, нормативы, поля #110, печать/PNG и SQLite-транзакции не меняются.

## Проверки

В [project-document.test.ts](../../../src/composables/__tests__/project-document.test.ts) добавлены **4 предварительных контракта**, сначала прошедшие на прежних composables: пустой документ/команды, раздельная очистка dirty/pending, точные поля open/clear и блокировка обеих сторон истории. До изменения runtime вместе с прежними document/recovery/session тестами прошли 42 сценария.

После переноса те же сценарии сохранены. Добавлены три проверки владельца: два потребителя читают/правят один живой документ без сброса истории и pending; разные app изолируют один project id, ошибки, loading, историю и ввод; явные ref-порты остаются у исходного владельца при другой active Pinia и не создают HTTP/таймеры.

В [useProjectSession.test.ts](../../../src/composables/__tests__/useProjectSession.test.ts) дополнительный consumer читает уже открытый/изменённый документ и применяет следующую правку. Проверяются один recovery repository, прежние пять window-listeners и две последовательные записи в один recovery id через существующую очередь. 44 публичных ключа и все прежние ожидания сохранены. Тестовые adapters получают настоящую отдельную Pinia; production workflows не подменяются. Итоговый затронутый набор — 46 тестов; полный check и browser CI фиксируются в PR на head/tree.

Новые проверки используют прежний вымышленный JSON fixture и программные draft-объекты. Рабочих ПУ-66, баз/backup, документов и графики в репозитории нет. #191 остаётся открытой до оставшейся session-facing проекции, навигации и итоговых проверок/Windows exe.
