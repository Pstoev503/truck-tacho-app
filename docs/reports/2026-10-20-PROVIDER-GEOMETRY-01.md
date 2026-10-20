# PROVIDER-GEOMETRY-01 — review receipt

## Етап и обхват

- Base INT29: `33206fa07a4c36e002a0a32372874c634b8603fe`.
- Branch: `codex/provider-geometry-01-handoff`.
- Implementation commit: `2244479701bec438560bd87ddd96f952b5fa7370`; this receipt/test-fixture refinement follows it.
- Точно четири файла спрямо base: `boss.html`, `ui/provider-geometry.mjs`, `ui/provider-geometry.test.mjs`, този report. `ui/truck-profile-input.test.mjs` е възстановен точно от base и няма diff.
- Engine decoder и лимит са само прочетени/импортирани от `engine/route.js`.

## Изпълнени етапи

1. Приетият review беше върнат заради тестов файлов обхват, пропускане на невалидни leg-ове, decoder injection и недостатъчна atomic failure проверка.
2. `providerGeometry(trip)` вече използва реалните `decodePolyline6` и `MAX_GEOMETRY_POINTS`. Невалиден trip/leg, липсващ, празен или не-string shape и decoder failure отказват целия вариант с bounded `ProviderGeometryError`; aggregate overflow се отказва, не се отрязва.
3. `boss.html` прихваща грешката преди geometry/provenance/storage/map промени. Само познатите helper errors показват собственото bounded съобщение; всяка друга грешка показва общ текст.
4. Новият `ui/provider-geometry.test.mjs` изпълнява действителния inline script. Failure сценарии започват с вече съществуваща manual или provider линия; проверяват array identity/стойности, provenance, storage, route summary/waypoints, нула save/draw/mark извиквания, видима грешка и липса на throw.

## Реални проверки

- `node --test ui/provider-geometry.test.mjs` — 16/16 passed; включва 21 невалидни trip/leg форми, exact-limit 20 000, aggregate overflow, валиден multileg маршрут и UI failures с предишна manual/provider линия.
- `node --test ui/*.test.mjs integration/*.test.mjs` — 247/247 passed.
- `cd engine && node --test` — 466/466 passed. Общо: 713 теста, но в отделните групи 247 UI/integration и 466 engine.
- `node --test --test-name-pattern='boss selector rejects aggregate overflow|boss selector rejects valid geometry followed' ui/provider-geometry.test.mjs` — 10/10 passed срещу фиксирания inline selector.
- Actual old-boss baseline от INT29: `git show 33206fa07a4c36e002a0a32372874c634b8603fe:boss.html > /tmp/provider-geometry-baseline-boss.html`, после `PROVIDER_GEOMETRY_BOSS_SOURCE=/tmp/provider-geometry-baseline-boss.html node --test --test-name-pattern='boss selector rejects aggregate overflow|boss selector rejects valid geometry followed' ui/provider-geometry.test.mjs` — очаквано 10/10 fail. Inline harness директно установи 39 999 точки вместо предишните 2/3, както и пропусната или изхвърлена грешка при invalid leg-овете.
- Посоченият workflow run `39433225012` е `action_required` с **0 jobs**; проверката на logs потвърди, че няма failed jobs, следователно това не е тестов pass/fail. INT29 run `39431524953` е success.
- Secret scan: чист. `git diff --check`: чисто.

## Ограничения, блокер и следваща стъпка

- Inline harness използва synthetic JSON fixtures и няма Leaflet; map липсата на мутация се доказва с нула draw calls плюс непроменени route summary/waypoints, не с визуален browser тест.
- Няма live-router, production или server/PostgreSQL проверка; няма промени по engine, profile, traffic, workflow, зависимости или server.
- Блокер: няма. Следваща стъпка: независим review на новия commit спрямо INT29. Това не е merge или production одобрение.
