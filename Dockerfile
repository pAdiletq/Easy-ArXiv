FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    APP_ENV=production \
    SAVED_STORE=firestore \
    PORT=8080
WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt \
    && useradd --system --uid 10001 --create-home appuser \
    && mkdir -p /app/data /app/static/images \
    && chown -R appuser:appuser /app

# Explicit allowlist: never COPY a .env, Git history, local database or credentials.
COPY --chown=appuser:appuser server.py cloud_store.py ./
COPY --chown=appuser:appuser static/*.html ./static/
COPY --chown=appuser:appuser static/brand.svg ./static/
COPY --chown=appuser:appuser static/css ./static/css/
COPY --chown=appuser:appuser static/js ./static/js/
COPY --chown=appuser:appuser static/images/cornell-campus.jpg ./static/images/

USER 10001:10001
EXPOSE 8080
CMD ["python", "server.py"]
