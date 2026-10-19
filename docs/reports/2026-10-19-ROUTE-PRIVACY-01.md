# ROUTE-PRIVACY-01 — начална етапна записка

Подготвено от Codex,19.10.2026 около16:28 Europe/Sofia. Task#84. Това е работен контекст за Copilot, не готова поправка.

Base е приетият REG-01 8aa906ff0c9d8da34085fd299f7c3f2984c20520,43baseline PostgreSQL теста потвърдени от изолирания INT12CI със същите server blobs. Отделният клон codex/route-privacy-01-handoff и Draft PR към codex/reg-01-handoff пазят приетия REG branch. Codex добавя само този разрешен отчет.

Само main.py/test_api.py/server README/този report. Цел: премахване на неявния public demo routing default; без изрично валиден VALHALLA_URL endpointът връща503 преди outbound request. Пълни критерии в#84. Не се променят истински env/credentials/услуги.

Runtime още не е променен, няма нови тестове или твърдение за готовност. Copilot потвърждава checkout receipt и собствена оценка, после попълва действителни base/head/файлове/проверки/ограничения/блокери. Оценка1–2ч, не гаранция, контрол17:30/новартефакт. Безmerge/deploy. M3 и M4b остават отделно.
