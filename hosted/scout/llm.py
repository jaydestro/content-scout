"""Content Scout — LLM helper.

Thin wrapper over the Foundry model deployment. Uses the ``openai`` SDK
pointed at Azure OpenAI via the Foundry account endpoint, authenticated
with the agent's Managed Identity (no API keys).

The model is chosen at deploy time via ``MODEL_DEPLOYMENT_NAME`` in agent.yaml
and provisioned by ``infra/main.bicep`` (default: gpt-4o-mini).

Graceful degradation: if neither the endpoint nor the model deployment name
are set, ``complete()`` returns None and callers should fall back to
deterministic templates. This keeps ``scout scan`` working even without an
LLM (only social-post drafting / sentiment / trends rely on it).
"""

from __future__ import annotations

import logging
import os
from typing import Optional

logger = logging.getLogger("content-scout.llm")

_client = None  # cached AzureOpenAI client
_api_version = "2024-10-21"


def _endpoint() -> Optional[str]:
    # Prefer Foundry-scoped endpoint; fall back to raw Cognitive Services endpoint.
    return (
        os.getenv("AZURE_AI_PROJECT_ENDPOINT")
        or os.getenv("AZURE_AI_FOUNDRY_ENDPOINT")
        or os.getenv("AZURE_OPENAI_ENDPOINT")
    )


def _deployment() -> Optional[str]:
    return os.getenv("MODEL_DEPLOYMENT_NAME")


def is_configured() -> bool:
    return bool(_endpoint() and _deployment())


def _get_client():
    global _client
    if _client is not None:
        return _client

    if not is_configured():
        return None

    try:
        from azure.identity import DefaultAzureCredential, get_bearer_token_provider
        from openai import AzureOpenAI
    except ImportError as e:
        logger.warning("openai/azure-identity not installed — LLM disabled: %s", e)
        return None

    credential = DefaultAzureCredential(exclude_interactive_browser_credential=True)
    token_provider = get_bearer_token_provider(
        credential, "https://cognitiveservices.azure.com/.default"
    )
    _client = AzureOpenAI(
        azure_endpoint=_endpoint(),
        azure_ad_token_provider=token_provider,
        api_version=_api_version,
    )
    return _client


def complete(
    prompt: str,
    system: str = "You are a helpful assistant.",
    *,
    temperature: float = 0.7,
    max_tokens: int = 400,
) -> Optional[str]:
    """Return the model's text response, or None if LLM is unavailable."""
    client = _get_client()
    if client is None:
        return None
    try:
        response = client.chat.completions.create(
            model=_deployment(),
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": prompt},
            ],
            temperature=temperature,
            max_tokens=max_tokens,
        )
        return response.choices[0].message.content
    except Exception as e:
        logger.warning("LLM call failed: %s", e)
        return None
