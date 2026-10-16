# Потвърдена основа на Top10EU

Инвентарът е ограничен до файловете, достъпни в GitHub на 2026-10-16. Наличието на код или тестов файл не доказва, че кодът работи или че тестовете са изпълнени успешно.

## Потвърдени Git основи

| Обект | Потвърдено състояние | Доказателство |
| --- | --- | --- |
| `main` | `26ef2442910757d4427670de38d61d6b78d1ad99` | [GitHub branch](https://github.com/Pstoev503/truck-tacho-app/tree/26ef2442910757d4427670de38d61d6b78d1ad99) |
| `shef` | `449dc5e047e9e71b5fdd0c9a22a3331b8e16e4be` | [GitHub branch](https://github.com/Pstoev503/truck-tacho-app/tree/449dc5e047e9e71b5fdd0c9a22a3331b8e16e4be) |
| PR #7 | Отворен, не е слят; base е `main`, head е `shef` на горния SHA | [PR #7](https://github.com/Pstoev503/truck-tacho-app/pull/7) |
| Работно копие за тази задача | `copilot/copilot-inventory-file-bounds` на `af239cfc552dc3fe83ad19d42897a35100119b12`; в локалните refs няма `main`/`shef` | `git branch -avv`, `git rev-parse HEAD` |

Преди употреба на този инвентар сверявайте текущите GitHub refs. PR #7 съдържа 29 променени файла; инвентарът тук не го слива и не пренася неговите runtime файлове.

## Достъпни модули и файлови доказателства

| Област | Какво е налично в потвърдената база | Файлови доказателства |
| --- | --- | --- |
| Тахографски броячи и дневник | В `main` има анализатор на дневника, броячи и наблюдение на скоростта. README описва изчисление от дневника, а не независимо потвърждение на нормативно съответствие. | [`engine/tacho-rules.js`](https://github.com/Pstoev503/truck-tacho-app/blob/26ef2442910757d4427670de38d61d6b78d1ad99/engine/tacho-rules.js), [`engine/activity-log.js`](https://github.com/Pstoev503/truck-tacho-app/blob/26ef2442910757d4427670de38d61d6b78d1ad99/engine/activity-log.js), [`engine/overspeed.js`](https://github.com/Pstoev503/truck-tacho-app/blob/26ef2442910757d4427670de38d61d6b78d1ad99/engine/overspeed.js), [`engine/README.md`](https://github.com/Pstoev503/truck-tacho-app/blob/26ef2442910757d4427670de38d61d6b78d1ad99/engine/README.md) |
| Android сонда | Android приложение със Bluetooth/BLE проби и ITS протокол/сесия; изходният код и тестовете са отделени в `android-sonda/`. Това доказва наличието на сонда, не потвърдена съвместимост с тахограф. | [`BtClassic.kt`](https://github.com/Pstoev503/truck-tacho-app/blob/449dc5e047e9e71b5fdd0c9a22a3331b8e16e4be/android-sonda/app/src/main/java/eu/top10/tachosonda/BtClassic.kt), [`GattProbe.kt`](https://github.com/Pstoev503/truck-tacho-app/blob/449dc5e047e9e71b5fdd0c9a22a3331b8e16e4be/android-sonda/app/src/main/java/eu/top10/tachosonda/GattProbe.kt), [`ItsProtocol.kt`](https://github.com/Pstoev503/truck-tacho-app/blob/449dc5e047e9e71b5fdd0c9a22a3331b8e16e4be/android-sonda/app/src/main/java/eu/top10/tachosonda/ItsProtocol.kt), [`ItsProtocolTest.kt`](https://github.com/Pstoev503/truck-tacho-app/blob/449dc5e047e9e71b5fdd0c9a22a3331b8e16e4be/android-sonda/app/src/test/java/eu/top10/tachosonda/ItsProtocolTest.kt) |
| Карта и маршрути | Добавени са в PR #7: шефският интерфейс, маршрутният модул и тестът му, синхронизационен модул и локален Leaflet vendor. PR също описва изпращане и преглед на маршрут; това е описание на промяната, не изпълнена проверка. | [`boss.html`](https://github.com/Pstoev503/truck-tacho-app/blob/449dc5e047e9e71b5fdd0c9a22a3331b8e16e4be/boss.html), [`engine/route.js`](https://github.com/Pstoev503/truck-tacho-app/blob/449dc5e047e9e71b5fdd0c9a22a3331b8e16e4be/engine/route.js), [`engine/route.test.js`](https://github.com/Pstoev503/truck-tacho-app/blob/449dc5e047e9e71b5fdd0c9a22a3331b8e16e4be/engine/route.test.js), [`vendor/leaflet-1.9.4/`](https://github.com/Pstoev503/truck-tacho-app/tree/449dc5e047e9e71b5fdd0c9a22a3331b8e16e4be/vendor/leaflet-1.9.4) |
| Сървър | PR #7 добавя FastAPI/PostgreSQL API, модели, сигурност, Docker и API тестове. | [`server/app/`](https://github.com/Pstoev503/truck-tacho-app/tree/449dc5e047e9e71b5fdd0c9a22a3331b8e16e4be/server/app), [`server/tests/test_api.py`](https://github.com/Pstoev503/truck-tacho-app/blob/449dc5e047e9e71b5fdd0c9a22a3331b8e16e4be/server/tests/test_api.py), [`server/Dockerfile`](https://github.com/Pstoev503/truck-tacho-app/blob/449dc5e047e9e71b5fdd0c9a22a3331b8e16e4be/server/Dockerfile) |
| Синхронизация | PR #7 добавя клиентски `engine/sync.js`; README на сървъра описва синхронизационния API. Няма отделен `sync.test.js` в инвентара на `shef`. | [`engine/sync.js`](https://github.com/Pstoev503/truck-tacho-app/blob/449dc5e047e9e71b5fdd0c9a22a3331b8e16e4be/engine/sync.js), [`server/README.md`](https://github.com/Pstoev503/truck-tacho-app/blob/449dc5e047e9e71b5fdd0c9a22a3331b8e16e4be/server/README.md) |
| Тестове и автоматизация | В `main` има Node тестове за броячи, дневник и скорост, Android протоколен тест и workflow за сондата. PR #7 добавя маршрутни/API тестове и workflow `tests.yml`. Това са файлови доказателства за тестове и автоматизация, не за резултат от изпълнение. | [`engine/*test.js`](https://github.com/Pstoev503/truck-tacho-app/tree/26ef2442910757d4427670de38d61d6b78d1ad99/engine), [`android-sonda/app/src/test/`](https://github.com/Pstoev503/truck-tacho-app/tree/449dc5e047e9e71b5fdd0c9a22a3331b8e16e4be/android-sonda/app/src/test), [workflow `sonda.yml`](https://github.com/Pstoev503/truck-tacho-app/blob/449dc5e047e9e71b5fdd0c9a22a3331b8e16e4be/.github/workflows/sonda.yml), [workflow `tests.yml`](https://github.com/Pstoev503/truck-tacho-app/blob/449dc5e047e9e71b5fdd0c9a22a3331b8e16e4be/.github/workflows/tests.yml) |
| Радио | Налични са `radio/radio.html` и отделен `radio/server/`; не са част от предложеното преместване. | [`radio/`](https://github.com/Pstoev503/truck-tacho-app/tree/449dc5e047e9e71b5fdd0c9a22a3331b8e16e4be/radio) |

## Код срещу изпълнени проверки

- Този агент не е изпълнявал тестове или build върху `main`, `shef` или PR #7. Не е проверявал статус на GitHub Actions; следователно тук няма твърдение за успешен CI.
- Описанието на PR #7 съобщава 98 Node, 22 PostgreSQL, 27 браузърни и 32 end-to-end теста. Това са отчетени от автора резултати в описанието на PR, не независимо повторени проверки в тази задача.
- В предоставеното описание на issue Codex съобщава последен локален резултат за planner: 113 теста, 111 успешни и 2 неуспешни в `plan.test.js:82` и `plan.test.js:139`. Това не е изпълнено от този агент и не е проверено върху кода.
- `engine/plan.js`, `engine/plan.test.js`, `engine/csv.js`, `engine/csv.test.js` и `server/tests/test_hardening.py` липсват от текущото cloud checkout. По-нова локална версия `C:\Top10EU` е наблюдение, предоставено от Codex в issue; кодът не е достъпен тук и не е инспектиран или синхронизиран с `shef`.
- Няма процент готовност. Наличието на код, тестове или workflow не е оценка за завършеност.

## Следваща организация на документацията

Предложените роли и целево дърво са в [FILE-OWNERSHIP.md](FILE-OWNERSHIP.md) и [REPOSITORY-LAYOUT.md](REPOSITORY-LAYOUT.md). Координационният отчет и безопасните следващи стъпки са в [отчета от 2026-10-16](../reports/2026-10-16-repository-coordination.md).
