# Сървърът заедно с приложението (index.html, boss.html, engine/) в един образ.
# Сглобява се от корена на хранилището:  docker build -f server/Dockerfile .
FROM python:3.13-slim
WORKDIR /app
COPY server/requirements.txt /app/server/requirements.txt
RUN pip install --no-cache-dir -r /app/server/requirements.txt
COPY server/app /app/server/app
COPY index.html boss.html manifest.json sw.js planner.html /app/web/
COPY engine /app/web/engine
COPY vendor /app/web/vendor
COPY ui /app/web/ui
# X-Forwarded-For се вярва само от посочените адреси (в docker compose — от Caddy)
ENV WEB_ROOT=/app/web PYTHONUNBUFFERED=1 FORWARDED_ALLOW_IPS=127.0.0.1
WORKDIR /app/server
EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers"]
