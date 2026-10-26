# Общие HTTP-компоненты (#135)

`server/http/` владеет транспортными операциями прежнего обработчика. `server/index.ts` сохраняет порядок маршрутов, проверки входных схем и вызовы фасада; группировка routes и узкие зависимости — следующий этап. Нового router framework, middleware pipeline или алгоритма обработки запросов не вводится.

## Владельцы

| Модуль        | Ответственность                                                                        |
| ------------- | -------------------------------------------------------------------------------------- |
| request-error | Прежний RequestError со status/message                                                 |
| json          | JSON-ответы с no-store/nosniff, Content-Type и чтение тела с лимитом байтов            |
| security      | Host и Origin с прежними разрешёнными localhost/127.0.0.1 адресами и портами           |
| path          | Однократный decodeURIComponent и UUID guard проекта/recovery                           |
| static-files  | StaticFiles, directory/default reader, allowlist, MIME и ошибки отсутствующих ресурсов |
| binary        | PDF/filename, PNG preview/no-store и PNG с SHA-256 ETag/304                            |
| error-mapper  | Порядок отображения прикладных ошибок, детали подтверждений и общий 500/диагностика    |

Транспорт не открывает SQLite и не получает RegistryStore. Error mapper импортирует существующие конструкторы ошибок их владельцев; HTTP знает, как показать прикладной отказ, а repositories/services не знают HTTP. Для ошибки 500 нужен только узкий serverError diagnostics port.

## Сохранённые контракты

Host/Origin проверяются до тела запроса. Прежний Content-Type startsWith, GET/HEAD исключение из Origin guard, порты разработки/preview и отсутствие CORS-заголовков сохранены. ReadJson собирает Buffer/string chunks, считает байты до JSON.parse, сохраняет default 64 КиБ и переданные маршрутом лимиты; ошибки потока не превращаются в ошибку JSON. Декодирование ключа и UUID guard сохраняют тексты/статусы. Новая валидация в переносе не добавляется.

JSON сохраняет Content-Type/Cache-Control/X-Content-Type-Options. PDF сохраняет байты и inline UTF-8 filename*. Preview PNG сохраняет no-store и защитные заголовки, catalog PNG — SHA-256 точных байтов, weak/list/wildcard If-None-Match, 304 без тела и прежние cache/security headers. Нормативный лист, PNG-экспорт и генерация PDF не меняются: переносится только HTTP-ответ готовыми байтами.

Статика сохраняет только index/favicon/assets без вложенных каталогов и два legal-файла. MIME проверяется после получения ресурса, прежние три варианта 404 и порядок вызовов reader сохраняются. После смены расположения модуля default URL скорректирован на ../../dist/; общий каталог остаётся тем же. Index сохраняет прежние экспорты directoryFiles/StaticFiles для desktop/SEA и тестов. SEA-reader передаётся как прежде.

ParameterConfirmationConflict остаётся раньше RevisionConflict, поэтому reason/field не теряются. Диагностический rejection вычисляется до отправки ответа, событие запроса остаётся на finish с прежней очисткой route. Ожидаемые ошибки не становятся server failures. Только неизвестная ошибка получает общий 500, затем прежние diagnostics.serverError и console.error с исходным значением.

## Проверки и следующий шаг

20 [контрактов API](../../server/__tests__/http-api-contracts.test.ts) прошли до переноса на прежнем обработчике: Host/Origin/приоритет guard, media type/JSON/точная граница 64 КиБ, адреса/UUID/методы, allowlist/MIME/404, PDF/PNG/ETag и матрица ошибок/500/диагностики. Восемь [прямых проверок без фасада](../../server/__tests__/http-transport.test.ts) фиксируют split UTF-8/байтовый лимит/строковые chunks, ошибку потока, decode once, plain Node server, реальные файлы/default dist, preview/cache PNG, конфликт подтверждения и non-Error отказ. Старые API/cache/PDF/parameter-rejection/diagnostics, frozen-format/SQLite/конкурентные тесты и полный E2E остаются обязательными.

Тела восьми функций, трёх бинарных ответов и полного упорядоченного error ladder сохранены после переноса; отдельно корректируется относительный URL default dist. Следующий шаг — project/recovery route group с узкими зависимостями, затем ПУ-66, signs/documents, system/diagnostics/legacy, bootstrap/shutdown и удаление фасада. #135/А4 открыты; JSON v10/SQLite v13, нормативы и поля #110 сохраняются. Новых зависимостей нет.
