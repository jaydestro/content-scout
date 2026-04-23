"""Content Scout — Key Vault secrets loader.

Loads scanner API keys (Reddit, YouTube, Bluesky, X) from Azure Key Vault
at startup using the agent's Managed Identity, then exposes them via
``os.environ`` so the rest of the code (scanner.py) remains unchanged.

Why Key Vault instead of plain env vars?
    1. Secrets are auditable (KV access logs land in Log Analytics).
    2. Rotation is centralized — no redeploy needed to change a key.
    3. Only the MI can read them — no `az keyvault secret show` from a
       dev workstation unless that workstation has been granted RBAC.

In local development, if AZURE_KEY_VAULT_NAME is not set, this is a no-op
and values are expected to come from .env (loaded by python-dotenv).
"""

from __future__ import annotations

import logging
import os
from typing import Iterable

logger = logging.getLogger("content-scout.secrets")

# Secret name in Key Vault → env var name the code expects.
# Use lowercase + hyphens for KV secret names (KV naming rules).
SECRET_MAP: dict[str, str] = {
    "youtube-api-key": "YOUTUBE_API_KEY",
    "reddit-client-id": "REDDIT_CLIENT_ID",
    "reddit-client-secret": "REDDIT_CLIENT_SECRET",
    "bluesky-handle": "BLUESKY_HANDLE",
    "bluesky-app-password": "BLUESKY_APP_PASSWORD",
    "x-bearer-token": "X_BEARER_TOKEN",
}


def load_secrets_from_keyvault(secret_names: Iterable[str] | None = None) -> dict[str, str]:
    """Populate os.environ from Key Vault. Returns the dict of loaded values.

    Missing secrets are skipped quietly so operators can omit any scanner they
    don't want to enable.
    """
    kv_name = os.getenv("AZURE_KEY_VAULT_NAME")
    kv_url = os.getenv("AZURE_KEY_VAULT_ENDPOINT")

    if not kv_name and not kv_url:
        logger.info("No Key Vault configured — using env vars directly")
        return {}

    if not kv_url and kv_name:
        kv_url = f"https://{kv_name}.vault.azure.net"

    from azure.identity import DefaultAzureCredential
    from azure.keyvault.secrets import SecretClient
    from azure.core.exceptions import ResourceNotFoundError, ClientAuthenticationError

    credential = DefaultAzureCredential(exclude_interactive_browser_credential=True)
    try:
        client = SecretClient(vault_url=kv_url, credential=credential)
    except ClientAuthenticationError as e:
        logger.error("Key Vault auth failed: %s", e)
        return {}

    targets = list(secret_names) if secret_names is not None else list(SECRET_MAP.keys())
    loaded: dict[str, str] = {}

    for secret_name in targets:
        env_name = SECRET_MAP.get(secret_name, secret_name.upper().replace("-", "_"))
        try:
            secret = client.get_secret(secret_name)
            if secret.value:
                os.environ[env_name] = secret.value
                loaded[env_name] = "***"  # never log values
                logger.info("Loaded secret '%s' → env %s", secret_name, env_name)
        except ResourceNotFoundError:
            logger.debug("Secret '%s' not present in KV (skipping)", secret_name)
        except Exception as e:
            logger.warning("Failed to load secret '%s': %s", secret_name, e)

    logger.info("Loaded %d secrets from Key Vault", len(loaded))
    return loaded
