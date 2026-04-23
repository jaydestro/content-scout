FROM python:3.12-slim

WORKDIR /app

COPY . user_agent/
WORKDIR /app/user_agent

RUN if [ -f requirements.txt ]; then \
        pip install --no-cache-dir -r requirements.txt; \
    else \
        echo "No requirements.txt found"; \
    fi

# Config files are loaded at runtime from Azure Blob Storage (via scout/storage.py)
# when AZURE_STORAGE_ACCOUNT_NAME is set, or from SCOUT_CONFIG_PATH locally.
# They are intentionally NOT baked into the image so configs can change without
# rebuilding the container.

EXPOSE 8088

CMD ["python", "main.py"]
