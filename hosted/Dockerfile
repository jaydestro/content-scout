FROM python:3.12-slim AS base

# Security hardening: run as a non-root user, no cached layers, minimal image.
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

# System deps (curl for healthcheck, ca-certificates for TLS to Azure endpoints)
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system scout \
    && useradd --system --gid scout --home /app --shell /usr/sbin/nologin scout

# Install Python deps first so this layer caches when code changes.
COPY hosted/requirements.txt .
RUN pip install --pre --no-cache-dir -r requirements.txt

# Application code + shared config files.
COPY hosted/ .
COPY .github/agents/ /app/.github/agents/
COPY .github/prompts/ /app/.github/prompts/

# Drop privileges.
RUN chown -R scout:scout /app
USER scout

EXPOSE 8088

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
    CMD curl -fsS http://localhost:8088/healthz || exit 1

CMD ["python", "app.py"]
