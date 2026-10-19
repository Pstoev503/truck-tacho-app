# ROUTE-PRIVACY-01 — етапна записка

Прието от Copilot в отделния checkout на PR#85,19.10.2026. Task#84.

Checkout receipt: `codex/route-privacy-01-handoff`, target `codex/reg-01-handoff`, начален HEAD `6eb6691fa81e2d255c8c5de7227cb3278d00a198`. Base е приетият REG-01 `8aa906ff0c9d8da34085fd299f7c3f2984c20520`; implementation commit/head `be35d60`, report/validation commit `e8f32b0`. Този PR пази приетия branch отделно. Собствена оценка: 1–2 часа, не гаранция.

Променени са само разрешените четири файла: `server/app/main.py`, `server/tests/test_api.py`, `server/README.md` и този отчет. Валидира се изричен абсолютен HTTP(S) `VALHALLA_URL`; при липса или невалидна стойност endpoint-ът връща 503 преди outbound request. Няма fallback към demo или друг host. HTTP(S) base path се запазва, trailing slash се премахва и `/route` се добавя. Не са променяни истински env/credentials/услуги.

Проверки: `server/tests/test_api.py` срещу изолиран PostgreSQL 16 — 60 passed (43 съществуващи и 17 нови параметризирани проверки); `python -m py_compile server/app/main.py server/tests/test_api.py`, `git diff --check` и `docker build -f server/Dockerfile -t route-privacy-01-server-test .` — успешни. Pytest показва едно предупреждение за deprecated `httpx` интеграция в Starlette. CodeQL: 0 alerts. Автоматичната code review не стартира поради модел, липсващ в registry; CI run от този branch няма. Няма проверка към реален Valhalla endpoint/мрежа. Непокрито от този пакет: `costing=truck` не удостоверява реални размери/ADR/тегло; M4b vehicle profile/rate limiting и M3 join throttle остават отделни. Без merge/deploy.
