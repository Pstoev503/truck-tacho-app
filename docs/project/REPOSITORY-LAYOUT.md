# Предложена подредба на хранилището

Тук е документирана целева подредба, не направено преместване. До одобрена отделна миграция `engine/`, `server/`, `android-sonda/`, `radio/`, `vendor/` и runtime HTML остават на текущите си места.

## Документация

| Папка | Предназначение |
| --- | --- |
| `docs/project/` | Потвърдена основа, собственост, граници и координация |
| `docs/providers/` | Доставчици, условия и лицензи, с произход и дата на проверка |
| `docs/references/` | Разрешени reference файлове, с източник, версия и лиценз |
| `docs/reports/` | Отчети за инвентар, проверки и миграции |

Не копирайте в `docs/references/` непроверени документи или файлове без разрешение и произход. Наличието на нормативно заглавие само по себе си не потвърждава API спецификация.

## Runtime миграция — само предложение

Възможна цел за уеб пакет е `web/` за страниците и техните браузърни активи. Следната таблица описва бъдещия diff, не промени от тази задача.

| Old path (проверен в `shef`) | New path (предложение) | Импорти, static serving и други засегнати настройки |
| --- | --- | --- |
| `index.html` | `web/index.html` | Проверете ES module imports към `./engine/*`, manifest линка и всички относителни URL-и. Запазете публичните `/` и `/index.html` адреси чрез root mapping към `web/`. |
| `boss.html` | `web/boss.html` | Проверете asset imports, маршрутния UI и API адресите. Запазете `/boss.html` или осигурете контролирано пренасочване. |
| `engine/` | `web/engine/` | Обновете import-и само ако относителната структура се промени; запазването на `./engine/...` до страниците намалява риска. Проверете и други потребители на модулите. |
| `vendor/` | `web/vendor/` | Обновете относителните CSS/JS/image URL-и и адресите, включени в service-worker cache. |
| `manifest.json` | `web/manifest.json` | Обновете `<link rel="manifest">`; проверете `start_url`, икони и scope спрямо публичния root. |
| `sw.js` | `web/sw.js`, достъпен публично и като `/sw.js` | Регистрацията от страницата трябва да остане на `/sw.js`, със scope `/`. Ако сървърът го сервира от `/web/sw.js`, осигурете alias и `Service-Worker-Allowed: /`; иначе worker-ът няма root scope. Проверете всички cache URL-и и сменете `CACHE_NAME`. |
| `server/Dockerfile` | остава `server/Dockerfile` | Текущият Dockerfile копира root HTML/manifest/worker и `engine/`/`vendor/` към `/app/web/`; актуализирайте `COPY` така, че новите източници да попадат в `WEB_ROOT=/app/web`. Build context от корена и `server/deploy/docker-compose.yml` също се проверяват. |
| `server/`, `android-sonda/`, `radio/` | без преместване в тази миграция | Проверете пътищата към статичните файлове, Android workflow и отделния radio server; изключени са от първата уеб подредба. |

Доказателствата за текущите маршрути са [`index.html`](https://github.com/Pstoev503/truck-tacho-app/blob/449dc5e047e9e71b5fdd0c9a22a3331b8e16e4be/index.html), [`sw.js`](https://github.com/Pstoev503/truck-tacho-app/blob/449dc5e047e9e71b5fdd0c9a22a3331b8e16e4be/sw.js), [`manifest.json`](https://github.com/Pstoev503/truck-tacho-app/blob/449dc5e047e9e71b5fdd0c9a22a3331b8e16e4be/manifest.json), [`server/Dockerfile`](https://github.com/Pstoev503/truck-tacho-app/blob/449dc5e047e9e71b5fdd0c9a22a3331b8e16e4be/server/Dockerfile) и [`server/deploy/docker-compose.yml`](https://github.com/Pstoev503/truck-tacho-app/blob/449dc5e047e9e71b5fdd0c9a22a3331b8e16e4be/server/deploy/docker-compose.yml).

### Предложени контролни стъпки

1. Преди преместване запишете базовия SHA и инвентар на всички import-и, URL-и, manifest полета, worker cache entries, static routes и Docker `COPY`.
2. Подгответе новите файлови пътища и съвместими URL alias-и в отделен PR; не изтривайте старите пътища в същия етап.
3. Проверете локалните тестове, Android build, Docker build и smoke тестовете на `/`, `/index.html`, `/boss.html`, `/sw.js`, всички модулни/assets URL-и и API пътищата. Отчетете действителния резултат и SHA.
4. Публикувайте само след потвърждение, че старите PWA клиенти могат да получат всички нужни URL-и. Service worker в `shef` изтрива старите кешове при activate; затова версията на кеша, старите URL-и и rollback трябва да се изпитат заедно.

### Rollback

При проблем върнете предишния Docker образ/static root и възстановете старите URL-и, без да изтривате потребителски данни. Оставете старите активи достъпни докато клиентите могат да се върнат към стария service worker; ако worker версията се промени, използвайте нова cache версия и проверете кешовете след rollback. Не приемайте успешен rollback само от възстановяване на HTML — проверете модулите, worker scope и API.
