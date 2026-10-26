# Сборка приложения и запуск без фасада (#135)

После выделения всех API-групп рабочие пути API, desktop и CLI переведены с RegistryStore на `createServerRuntime`. Это следующий совместимый шаг, а не завершение А4: фасад и адаптер прежнего createRegistryServer остаются для совместимых тестовых вызывающих до отдельного перевода и удаления.

## Владельцы и зависимости

| Модуль                       | Ответственность                                                                                                                                                        |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| composition-root             | Прежние подключение, миграция, seed и repositories/services на одном соединении; cleanup при отказе инициализации.                                                     |
| server-runtime               | Прямая сборка групп HTTP-зависимостей и узких CLI-команд из тех же сервисов; metadata, schemaVersion, backup и close одного соединения.                                |
| http/server                  | Фабрика HTTP-сервера: прежние security, порядок групп, отдельный parameter context, finish, error mapper и static/fallback. Не получает RegistryStore/DatabaseSync.    |
| bootstrap / index            | Запуск API, путь по TOD_DATABASE_PATH или прежнему default, umask, диагностика, listen и graceful shutdown по SIGINT/SIGTERM. Index сохраняет совместимые экспорты.    |
| desktop-instance / desktop   | Поиск уже работающей базы и launch lock до открытия файла, выбор порта/marker и прежнее принудительное завершение настольной программы. Создаёт runtime вместо фасада. |
| import-commands / import-cli | Только прежние plan/import/backup и backupDirectory. Preview/apply/no-op, лимиты, сообщения и finally close сохраняются.                                               |
| database/migration-notice    | Прежний текст миграционного сообщения по узким metadata; store сохраняет совместимый экспорт.                                                                          |
| compatibility-server / store | Временные адаптер и фасад для старых API/SQLite/контрактных тестов. Новые сценарии сюда не добавляются.                                                                |

Runtime не открывает второе соединение и не переносит SQL. Проекты и recovery используют общий ProjectSourceStore; ПУ-66 — прежние resolver/lifecycle/verification/import; документы и каталог — прежние исторические ссылки и атомарную команду удаления. HTTP-группы получают только объявленные порты. Clock передаётся прежним сервисам и ручному backup через callback. Старый фасад сохраняет свой receiver часов для совместимых контрактов.

В desktop сохраняется форма результата launchDesktop с полем store, но это уже ServerRuntime: lifecycle/metadata и группы зависимостей, без прежних forwarding methods. Поиск программы, lock, повторная проверка marker и только затем открытие базы идут в прежнем порядке. Неожиданный отказ listen закрывает соединение, finally снимает launch lock. API по-прежнему ждёт завершения активных запросов перед close; desktop сохраняет свой прежний closeAllConnections/release/close/exit. Эти политики не объединяются в новую универсальную схему.

Совместимый createRegistryServer перенесён из index в compatibility-server, экспорт из index сохранён. Адаптер оборачивает прежние методы на прежнем receiver и вызывает ту же createHttpServer. Поэтому старые API-контракты продолжают проверять общий HTTP-обработчик, а production/E2E проверяют прямую сборку без фасада.

## Проверки

Три [предварительных контракта](../../server/__tests__/bootstrap-contracts.test.ts) прошли до переноса: CLI ПУ-66 preview/apply/backup/no-op, запрет импорта знаков при отказе backup, закрытие соединения и снятие замка после неожиданного отказа listen. Вымышленные XLSX/ZIP/PNG создаются программно.

Шесть [прямых проверок runtime](../../server/__tests__/server-runtime.test.ts) фиксируют общие source/history проекта и recovery с чтением вторым соединением, связь импорта ПУ-66/lifecycle/verification/HTTP, исторический PNG/ETag и document delete guards/text, CLI-команды с настоящим pre-import backup, ожидание незавершённого HTTP-запроса перед SIGTERM close и будущую схему без изменения байтов/backup. Прежние desktop-instance проверки выполняются через runtime: идентичность базы, занятые/зарезервированные порты, marker/probe, поиск до миграции и гонка двух запусков; ожидания не ослабляются.

Локальный npm run check: **129 файлов / 979 тестов**, архитектура, публичные файлы, формат/lint/типы, прямой Node API/CLI/desktop и production build. AST-сверка сохраняет полный HTTP callback, тело runImport, текст migrationNotice и API signal loop после замены зависимостей. Полный локальный Chromium E2E: **56/56 без повторов**. CI и проверка Windows exe фиксируются в PR.

## Остаток А4

Перевести совместимые тестовые вызывающие с RegistryStore/createRegistryServer на владельцев хранения и runtime, удалить forwarding methods/адаптер и старые экспорты после поиска всех обращений. Затем на итоговом коде повторить необходимые контракты и Windows exe, зафиксировать завершение #135/А4. JSON v10/SQLite v13, нормативные алгоритмы, SVG/печать/PNG, поля #110 и состав данных сохраняются; новых зависимостей нет. Pinia #191 первой после А4, весь технический долг до новых функций.
