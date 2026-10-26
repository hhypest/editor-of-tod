# Маршруты ПУ-66 (#135)

`server/http/routes/pu66.ts` владеет 12 прежними HTTP-ветвями: список карточек; общий lifecycle; preview/apply исключения и возврата; status/history карточки; preview/apply XLSX; norms/scheme; чтение и запись сверок. Группа использует общий RouteHandler, JSON/body/path/error transport. RegistryStore/DatabaseSync и SQL не импортируются.

## Узкие зависимости

Pu66RouteDependencies разделяет пять наборов операций:

- cards: list/getNorms/getScheme;
- lifecycle: getStatus/list;
- verifications: list/record;
- существующие Pu66LifecycleCommands: plan/record/backup;
- существующие Pu66ImportCommands: preview/import/backup.

В группу передаются только эти наборы. Прямые тесты связывают первые три с repositories из composition root, команды — с существующими services и отдельным backup callback. Репозитории/сервисы и прикладные upload/lifecycle сценарии в этом PR не меняются.

## Сохранённые HTTP-контракты

Группа вызывается после Host/Origin и групп проектов/recovery. Совпадение пути/метода обрабатывается прежним кодом; false оставляет тело/заголовки/хранилище нетронутыми для следующей группы. Неизвестные методы и частичные адреса сохраняют общий fallback. Regexp status/history и более широкие prefix/suffix условия norms/scheme/verifications остаются разными, как прежде. Ключ декодируется один раз; алиасы и неоднозначность разрешаются существующим владельцем.

Отсутствующий status остаётся 200/null, отсутствующие history/norms/scheme/verifications и запись сверки — прежние 404. Lifecycle list включает исключённые карточки и добавляет статус каждой. Перед scheme остаётся guard исключения до запроса полей. Проверка body сверки предшествует record; дата/редакция/статус проверяются прежним repository, успешная запись отвечает 201. Белые списки проекций не расширяются.

Lifecycle apply сохраняет schema/fingerprint → backup → синхронную команду с повторной проверкой полного плана под блокировкой. XLSX сохраняет 56 МиБ транспортный лимит, существующие file/base64/count/total guards, preview без записи, no-op без backup и повторный fingerprint после backup перед записью. Источники/карточки/редакции и явные restore events остаются одной прежней транзакцией; исключение/возврат пакета также атомарны. Граница проверки import fingerprint остаётся прежней: перенос маршрута не переносит её внутрь транзакции.

## Совместимый переход и проверки

createRegistryServer сохраняет сигнатуру и пока собирает узкие callback-адаптеры к прежним методам фасада, как для projects/recovery. Объект фасада/соединения не передаётся в группу. Методы вызываются на прежнем receiver; bootstrap/forwarding methods остаются до перевода остальных вызывающих. Общий error mapper, routeOf/finish-диагностика и 23 остальных ветви/fallback сохраняются.

Три [предварительных контракта](../../server/__tests__/pu66-api-contracts.test.ts) прошли на прежнем index: missing-card статусы/ключи/неполные пути, сверки и guard исключения, общий lifecycle и stale-plan отказ до backup. Восемь [прямых проверок без RegistryStore](../../server/__tests__/pu66-routes.test.ts) используют вымышленные SQLite/XLSX и простые ports: aliases/проекции/privacy/сверки, exclude/restore и история, изменение плана во время backup, XLSX preview больше 64 КиБ/apply/no-op/явный restore, post-backup import fingerprint, оба rollback второго элемента и untouched fallback.

AST-сверка сохраняет все 12 перенесённых условий/тел после замены зависимостей; 23 остальных ветви и fallback совпадают. Старые API/web-import/lifecycle/read/verification/конкурентные/frozen-format проверки и полный E2E остаются обязательными. Новых зависимостей и рабочих данных нет; XLSX создаются программно.

После этой группы выделены [маршруты signs/documents/normative parameters](catalog-document-routes.md). Далее system/diagnostics/legacy, тонкий bootstrap/shutdown и удаление фасада. #135/А4 открыты; JSON v10/SQLite v13, поля #110, нормативные алгоритмы и выпускной лист сохраняются. Pinia первой после А4, переработка интерфейса — 0.4.0, настольные оболочки пока отложены.
