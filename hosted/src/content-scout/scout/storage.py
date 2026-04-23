"""Content Scout — Storage abstraction.

In hosted mode, reports and the dedup tracker are written to Azure Blob
Storage using Managed Identity. In local dev mode (no AZURE_STORAGE_ACCOUNT
env var), we fall back to the local filesystem so the same code works for
both the editor-mode agent and the hosted agent.

Security posture:
    - Blob backend uses DefaultAzureCredential → ManagedIdentityCredential
      in production. No connection strings, no account keys.
    - Storage account has `allowSharedKeyAccess=false` per the Bicep template
      so key-based access is impossible even if a key were leaked.
    - TLS 1.2 minimum, enforced by the storage account properties.
"""

from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Optional

logger = logging.getLogger("content-scout.storage")

REPORTS_CONTAINER = "reports"
SOCIAL_CONTAINER = "social-posts"


def _storage_account_url() -> Optional[str]:
    """Return blob endpoint if hosted-mode storage is configured."""
    account = os.getenv("AZURE_STORAGE_ACCOUNT_NAME")
    endpoint = os.getenv("AZURE_STORAGE_BLOB_ENDPOINT")
    if endpoint:
        return endpoint.rstrip("/")
    if account:
        return f"https://{account}.blob.core.windows.net"
    return None


def _get_blob_client(container: str, blob_name: str):
    """Create a BlobClient using Managed Identity."""
    from azure.identity import DefaultAzureCredential
    from azure.storage.blob import BlobClient

    endpoint = _storage_account_url()
    if not endpoint:
        raise RuntimeError("AZURE_STORAGE_ACCOUNT_NAME not set — blob storage unavailable")

    credential = DefaultAzureCredential(exclude_interactive_browser_credential=True)
    return BlobClient(
        account_url=endpoint,
        container_name=container,
        blob_name=blob_name,
        credential=credential,
    )


def is_hosted_storage() -> bool:
    """True when blob storage is configured; false for local dev."""
    return _storage_account_url() is not None


# ---------------------------------------------------------------------------
# Text read/write — used by reports, social posts, dedup
# ---------------------------------------------------------------------------

def write_text(container: str, blob_name: str, content: str) -> str:
    """Write text content. Returns the location (blob URL or local path).

    In hosted mode: uploads to blob storage via MI.
    In local mode: writes to ./{container}/{blob_name}.
    """
    if is_hosted_storage():
        client = _get_blob_client(container, blob_name)
        client.upload_blob(content.encode("utf-8"), overwrite=True)
        logger.info("Uploaded %s/%s (%d bytes)", container, blob_name, len(content))
        return f"{_storage_account_url()}/{container}/{blob_name}"

    # Local fallback
    local_path = Path(container) / blob_name
    local_path.parent.mkdir(parents=True, exist_ok=True)
    local_path.write_text(content, encoding="utf-8")
    logger.info("Wrote %s (%d bytes)", local_path, len(content))
    return str(local_path)


def read_text(container: str, blob_name: str) -> Optional[str]:
    """Read text content. Returns None if the blob/file does not exist."""
    if is_hosted_storage():
        try:
            client = _get_blob_client(container, blob_name)
            stream = client.download_blob()
            return stream.readall().decode("utf-8")
        except Exception as e:
            # Azure SDK raises ResourceNotFoundError — import lazily to avoid dep at import time
            from azure.core.exceptions import ResourceNotFoundError
            if isinstance(e, ResourceNotFoundError):
                return None
            logger.warning("Failed to read %s/%s: %s", container, blob_name, e)
            return None

    local_path = Path(container) / blob_name
    if not local_path.exists():
        return None
    return local_path.read_text(encoding="utf-8")


def list_blobs(container: str, prefix: str = "") -> list[str]:
    """List blobs/files by name in a container, optionally filtered by prefix."""
    if is_hosted_storage():
        from azure.identity import DefaultAzureCredential
        from azure.storage.blob import ContainerClient

        endpoint = _storage_account_url()
        credential = DefaultAzureCredential(exclude_interactive_browser_credential=True)
        client = ContainerClient(
            account_url=endpoint,
            container_name=container,
            credential=credential,
        )
        return sorted(b.name for b in client.list_blobs(name_starts_with=prefix))

    local_dir = Path(container)
    if not local_dir.exists():
        return []
    return sorted(str(p.relative_to(local_dir)) for p in local_dir.glob(f"{prefix}*") if p.is_file())
