# PROVIDER-GEOMETRY-01 — изпълнение и receipt

## Контекст

- Base: `33206fa07a4c36e002a0a32372874c634b8603fe` (INT29).
- Branch: `codex/provider-geometry-01-handoff`.
- Head: този receipt е част от финалния commit на задачата; точният commit е в PR историята.
- Обхват: точно четири файла — `boss.html`, `ui/provider-geometry.mjs`, `ui/truck-profile-input.test.mjs` и този receipt.

## Изпълнени етапи

1. Проверих предоставения checkout: предишният commit беше само seed report; реализацията на доставчика още липсваше.
2. Добавих чист helper за свързване на leg геометриите с общ таван 20 000 точки. Запазва съществуващото премахване на първата точка на следващ leg и отказва целия вариант при общо надвишаване — без отрязване на линията.
3. Промених избора в реалния inline script на `boss.html`: декодиране/валидация е преди всяка промяна на geometry, provenance, storage или map; грешката се показва в `routeErr`.
4. Добавих проверки за helper-а и изпълнение на действителния inline script с реалния decoder и синтетични отговори.

## Проверки

- `node --test ui/truck-profile-input.test.mjs` — 36/36 passed.
- `node --test ui/*.test.mjs integration/*.test.mjs` — 234/234 passed.
- `cd engine && node --test` — 700/700 passed.
- Инлайн сценарий: два валидно декодирани leg-а по 20 000 точки (39 999 след премахване на общата точка) вече се отказват видимо. Geometry, provenance, provider-selected флагът, черновата, обобщението на маршрута и waypoint list остават непроменени.
- Инлайн сценарий: грешка от реалния `decodePolyline6` се прихваща, показва се в `routeErr` и не променя състоянието.
- Покритията включват празни/липсващи leg-ове и shapes, единичен и съединен маршрут, празни сегменти, точно 20 000 точки, overflow, невалиден decoder резултат и липсваща decoder функция.

## Ограничения и следващо действие

- Предоставената baseline репродукция описва старото поведение: 2 × 20 000 точки се обединяват до 39 999, а decoder грешката излиза от click handler без съобщение в `routeErr`.
- Не са променяни engine decoder/target, server, профил, traffic, workflow, зависимости или production настройки.
- Не са изпълнявани server/PostgreSQL, live-router или production проверки; те не са нужни за тази клиентска промяна.
- Изпълнимият DOM harness няма Leaflet; той проверява липсата на промени в route summary и waypoint list, но не прави визуална browser/map проверка.
- Блокер: няма. Следващото действие е review на този stacked PR спрямо INT29 base; merge/production одобрението остава при собственика.
