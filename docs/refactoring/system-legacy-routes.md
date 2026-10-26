# Маршруты system/diagnostics/legacy (#135)

Из `server/index.ts` выделены последние девять API-ветвей: `http/routes/system.ts` (status/backup), `diagnostics.ts` (report/events/clear) и `legacy.ts` (GET/PUT crossings/normative). Группы не импортируют RegistryStore/DatabaseSync и не содержат SQL. Статика, общий fallback, security, finish-диагностика и error mapper остаются у общего обработчика.

## Зависимости и сохранённые контракты

- System получает путь/идентичность базы, instanceId и единственную команду backup. Прежний UUID allowlist probe, проверка отметки рядом с базой, отсутствие probe у базы в памяти и отсутствие пути в ответе сохраняются. DatabaseId по-прежнему вычисляется один раз при создании сервера; формат и сравнение баз не меняются. Backup сохраняет await, 201 и filename; тело этого запроса по-прежнему не читается.
- Diagnostics получает только report/record/clear. Схема клиентских событий, лимит 64 КиБ, очистка свободного текста/путей, журнал и порядок очистки сохраняются. Общий finish по-прежнему исключает GET diagnostics из статистики и записывает POST clear после очистки.
- `server/diagnostic-database.ts` владеет прежней сводкой базы. `DiagnosticDatabaseQueries` описывает только metadata и запросы, нужные для количеств и проекции каталога. Типы записей не нужны: элементы списков — unknown, каталог содержит только signCount/documentId/importedAt. Прежние тела сводки и report, порядок чтений, safe для каждого запроса, null/«недоступно», размер файла и число файлов backup сохраняются. Пути/ошибки/содержимое записей не включаются. Совместимый экспорт databaseSummary из diagnostics сохранён; report больше не импортирует тип фасада.
- Legacy получает четыре операции существующего LegacyRegistryRepository. Прежние write schemas нормализуют draft, expectedRevision передаётся отдельно. Каждое успешное сохранение, включая одинаковое, создаёт новую версию. Транзакции current/history, конфликты и rollback остаются у репозитория.
- Несовпавшие адреса и методы возвращают false без чтения тела или отправки ответа. Существующие группы не пересекаются; status/backup можно объединить, сохранив условия. Host/Origin остаются перед всеми группами; static/fallback после них сохранён.

`createRegistryServer` пока сохраняет публичную сигнатуру и связывает новые зависимости callback с прежними receiver фасада и DiagnosticsLog. Это временный адаптер для следующего шага, а не удаление фасада. Форматы JSON v10/SQLite v13, SQL/транзакции, поля #110, нормативные алгоритмы и лист не меняются. Новых зависимостей нет.

## Проверки и следующий шаг

Три [предварительных HTTP-контракта](../../server/__tests__/system-legacy-api-contracts.test.ts) прошли на исходном index до переноса: identity/probe/memory/методы, исключение report из статистики и finish после clear, независимый отказ query, legacy validation/новые версии/conflicts и backup.

Семь [прямых проверок](../../server/__tests__/system-legacy-routes.test.ts) без фасада фиксируют status/backup/headers, точную количественную сводку и обновляемые запросы, каждый недоступный query/файл, event/body limits/privacy/журнал, оба ручных реестра/историю/нормализацию, конфликт двух соединений и rollback обоих видов при отказе INSERT history, untouched fallback/body. Существующие HTTP/security/diagnostics/desktop, frozen formats/SQLite/backup и конкурентные проверки сохраняются.

Локальный `npm run check`: **127 файлов / 970 тестов**, архитектура, публичные файлы, формат, lint, типы, Node API/CLI/desktop и production build. AST-сверка сохраняет девять условий/тел маршрутов после замены зависимостей, тела report/databaseSummary и static/fallback. Полный локальный Chromium E2E: **56/56 без повторов**. Результат CI фиксируется в PR. Отдельная Windows exe для этого переноса не собиралась.

Все API-группы выделены; далее bootstrap/shutdown и перевод оставшихся вызывающих с удалением forwarding methods. #135/А4 остаются открыты до итоговых контрактов и Windows exe; затем первой идёт Pinia #191, далее остальной технический долг до новых функций.
