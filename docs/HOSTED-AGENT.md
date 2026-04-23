# Hosted Agent — Deployment Guide

> ⚠️ **Experimental / preview feature.**
>
> The hosted agent mode depends on the [Microsoft Foundry Hosted Agents](https://learn.microsoft.com/en-us/azure/foundry/agents/concepts/hosted-agents) preview. It requires:
> - **Subscription enrollment** in the Foundry Hosted Agents preview. Deployments without access fail with HTTP 400 `"The requested experience is not available for this subscription"`.
> - **A supported region.** As of April 2026: Australia East, Canada Central, North Central US, Sweden Central.
> - Pre-release Python packages (`agent-framework-foundry-hosting`) and the `azure.ai.agents` azd extension (preview).
>
> APIs, infra shape, and the `azd ai agent` CLI surface may change. For production / stable use, run Content Scout in **editor mode** instead.

Content Scout can run as a **Foundry hosted agent** — a containerized Python service deployed to Azure Foundry Agent Service. This enables automated scanning, scheduled operations, programmatic access, and team-wide availability via Teams or M365.

## Two Modes, One Agent

| Mode | How It Runs | Best For |
|------|------------|---------|
| **Editor mode** | Prompt-based agent inside VS Code, Claude Code, Cursor, etc. | Interactive onboarding, ad-hoc scans, reviewing results, generating posts |
| **Hosted mode** | Containerized Python app on Foundry Agent Service | Scheduled/automated scans, CI/CD integration, programmatic API access, Teams publishing |

Both modes read the same config files (`scout-config-*.prompt.md`) and produce the same reports. Onboarding is always done in editor mode — the hosted agent consumes the generated config.

## Architecture

```
┌──────────────────────────────────────────────┐
│  Editor Mode (prompt-based)                  │
│  VS Code / Claude Code / Cursor / CLI        │
│  ┌────────────────────────────────────────┐  │
│  │ .github/agents/content-scout.agent.md  │  │
│  │ (LLM executes scanning logic directly) │  │
│  └────────────────────────────────────────┘  │
│                    │                         │
│                    ▼                         │
│  .github/prompts/scout-config-{slug}.prompt.md
│  reports/     social-posts/                  │
└──────────────────────────────────────────────┘
          │ same config files │
          ▼                   ▼
┌──────────────────────────────────────────────┐
│  Hosted Mode (containerized)                 │
│  Azure Foundry Agent Service                 │
│  ┌────────────────────────────────────────┐  │
│  │ hosted/app.py                          │  │
│  │ (Python code implements scanning)      │  │
│  │ scout/scanner.py → HTTP calls          │  │
│  │ scout/quality.py → filter + score      │  │
│  │ scout/report.py  → generate markdown   │  │
│  └────────────────────────────────────────┘  │
│                    │                         │
│                    ▼                         │
│  Responses API (chat) + Invocations API      │
│  (automated JSON commands)                   │
└──────────────────────────────────────────────┘
```

## Prerequisites

- Azure subscription (Owner or Contributor + User Access Administrator — needed for role assignments)
- [Azure Developer CLI (`azd`)](https://learn.microsoft.com/azure/developer/azure-developer-cli/install-azd) installed
- Docker installed (azd builds and pushes the image)
- A scout config file (generated via editor-mode onboarding)

Everything else — Foundry account, Foundry project, model deployment, Container Registry, Managed Identity, Key Vault, Storage Account, Log Analytics, and all role assignments — is **provisioned by `azd up`** from [hosted/infra/main.bicep](../hosted/infra/main.bicep). No manual portal clicks.

## Deployment — end to end

```bash
cd hosted

# One-time setup
azd auth login
azd env new content-scout-prod          # or any env name
azd env set AZURE_LOCATION eastus2       # any region with Foundry + your chosen model

# Optional: pick a different LLM (default is gpt-4o-mini)
azd env set MODEL_NAME gpt-4o
azd env set MODEL_VERSION 2024-11-20
azd env set MODEL_CAPACITY 100

# Deploy everything
azd up
```

`azd up` runs in one shot and creates:

| Resource | Purpose |
|---|---|
| User-assigned Managed Identity | Zero-secret auth to Foundry, KV, Storage, ACR |
| Azure AI Foundry account + project | Hosts the agent runtime |
| Model deployment | The LLM the agent uses (gpt-4o-mini by default) |
| Azure Container Registry | Stores the agent Docker image |
| Azure Key Vault | Scanner API keys (RBAC-only, audit-logged) |
| Azure Storage Account | Persistent reports + dedup tracker (`allowSharedKeyAccess=false`) |
| Log Analytics workspace | Container logs + Foundry diagnostics |
| Role assignments | AcrPull + KV Secrets User + Blob Data Contributor + Azure AI User |

After deploy, upload scanner API keys to Key Vault (one-time, rotate anytime without redeploy):

```bash
KV_NAME=$(azd env get-values | grep AZURE_KEY_VAULT_NAME | cut -d= -f2 | tr -d '"')
az keyvault secret set --vault-name $KV_NAME --name youtube-api-key       --value '<your-key>'
az keyvault secret set --vault-name $KV_NAME --name reddit-client-id      --value '<id>'
az keyvault secret set --vault-name $KV_NAME --name reddit-client-secret  --value '<secret>'
az keyvault secret set --vault-name $KV_NAME --name bluesky-handle        --value '<handle>'
az keyvault secret set --vault-name $KV_NAME --name bluesky-app-password  --value '<app-pw>'
az keyvault secret set --vault-name $KV_NAME --name x-bearer-token        --value '<token>'
```

The agent loads these automatically at container start via Managed Identity — see [hosted/scout/secrets.py](../hosted/scout/secrets.py).

### Choosing a different LLM

Edit [hosted/infra/main.parameters.json](../hosted/infra/main.parameters.json) or override via `azd env set` **before** running `azd up`:

| Env var | Example | Notes |
|---|---|---|
| `MODEL_NAME` | `gpt-4o-mini` (default), `gpt-4o`, `gpt-5-mini` | Must be available in your region |
| `MODEL_VERSION` | `2024-07-18`, `2024-11-20` | Bicep pins the exact snapshot |
| `MODEL_CAPACITY` | `50` (default) | TPM in thousands (`GlobalStandard` SKU) |

The deployment's name is passed to the agent as `MODEL_DEPLOYMENT_NAME` — the code in [hosted/scout/llm.py](../hosted/scout/llm.py) reads that env var, uses `DefaultAzureCredential` → `ManagedIdentityCredential` for auth, and calls the model via the `openai` SDK. No API keys, ever.

### Option 2: Manual Docker build + deploy

```bash
# Build the container (from repo root)
docker build --platform linux/amd64 -t content-scout -f hosted/Dockerfile .

# Tag and push to ACR
az acr login --name <your-acr>
docker tag content-scout <your-acr>.azurecr.io/content-scout:latest
docker push <your-acr>.azurecr.io/content-scout:latest

# Deploy via Foundry SDK or CLI
```

### Environment Variables

All `AZURE_*` variables and `MODEL_DEPLOYMENT_NAME` are set **automatically** by `azd up` and injected into the container by the Foundry runtime. Scanner API keys come from Key Vault, loaded on startup.

| Variable | Source | Description |
|----------|--------|-------------|
| `AZURE_AI_PROJECT_ENDPOINT` | azd output | Foundry project endpoint |
| `AZURE_AI_FOUNDRY_ENDPOINT` | azd output | Cognitive Services endpoint |
| `MODEL_DEPLOYMENT_NAME` | azd output | LLM deployment name (default `gpt-4o-mini`) |
| `AZURE_CLIENT_ID` | azd output | Managed Identity client ID |
| `AZURE_KEY_VAULT_NAME` | azd output | KV holding scanner secrets |
| `AZURE_STORAGE_ACCOUNT_NAME` | azd output | Blob storage for reports |
| `SCOUT_CONFIG_PATH` | default `.github/prompts/` | Where product configs live in the container |
| `YOUTUBE_API_KEY` et al. | Key Vault at runtime | Scanner credentials, loaded via MI |

For local dev, copy [hosted/.env.example](../hosted/.env.example) to `hosted/.env` and populate only the values you want to override.


## Protocols

The hosted agent supports both Foundry protocols:

### Responses Protocol (conversational)

Use for interactive chat — same experience as editor mode but via API.

```bash
curl -X POST "{project_endpoint}/agents/content-scout/endpoint/protocols/openai/v1/responses" \
  -H "Authorization: Bearer $(az account get-access-token --query accessToken -o tsv)" \
  -H "Content-Type: application/json" \
  -d '{"input": "scout scan cosmos-db for April 2026"}'
```

### Invocations Protocol (automated)

Use for scheduled/automated commands with structured JSON.

```bash
curl -X POST "{project_endpoint}/agents/content-scout/endpoint/protocols/invocations" \
  -H "Authorization: Bearer $(az account get-access-token --query accessToken -o tsv)" \
  -H "Content-Type: application/json" \
  -d '{
    "command": "scan",
    "slug": "cosmos-db",
    "month": "2026-04"
  }'
```

### Available Commands

| Command | Parameters | Description |
|---------|-----------|-------------|
| `scan` | `slug` (optional), `month` (optional, YYYY-MM) | Run a content scan |
| `post` | `slug` (optional), `url` (required) | Generate social posts from a URL |
| `calendar` | `slug` (optional), `month` (optional) | Generate a posting calendar |
| `gaps` | `slug` (optional), `month` (optional) | Analyze content gaps |
| `trends` | `slug` (optional) | Show month-over-month trends |

## Automation Scenarios

### Scheduled Monthly Scan

Use Azure Logic Apps, Power Automate, or a cron job to invoke the scan command on the 1st of each month:

```json
{
  "command": "scan",
  "slug": "cosmos-db",
  "month": "2026-04"
}
```

### GitHub Actions Integration

```yaml
name: Monthly Content Scan
on:
  schedule:
    - cron: '0 9 1 * *'  # 9 AM on the 1st of every month
  workflow_dispatch:      # Manual trigger

jobs:
  scan:
    runs-on: ubuntu-latest
    steps:
      - name: Invoke Content Scout
        run: |
          curl -X POST "${{ secrets.FOUNDRY_ENDPOINT }}/agents/content-scout/endpoint/protocols/invocations" \
            -H "Authorization: Bearer ${{ secrets.FOUNDRY_TOKEN }}" \
            -H "Content-Type: application/json" \
            -d '{"command": "scan", "month": "'$(date +%Y-%m)'"}'
```

### Webhook Trigger

The Invocations protocol accepts arbitrary JSON, so you can wire up webhooks from external systems to trigger scans when specific events occur (e.g., a new product release, a conference announcement).

### Teams / M365 Publishing

Once deployed, publish the agent to Teams or M365 so team members can interact with it conversationally:

1. Deploy the agent to Foundry (steps above)
2. In the Foundry portal, go to your agent → Publish
3. Select Teams or M365 as the channel
4. Team members can chat with Content Scout directly in Teams

## Security posture

The hosted agent is designed for least-privilege, zero-secret operation:

| Surface | Control |
|---|---|
| **Entra ID auth** | Single User-assigned Managed Identity attached to the Foundry account. No service principals, no client secrets. |
| **Container Registry** | Admin user disabled; MI has `AcrPull` only. |
| **Key Vault** | RBAC-only (access policies disabled); MI has `Key Vault Secrets User` (read-only); purge protection + soft delete on. |
| **Storage Account** | `allowSharedKeyAccess=false` (MI-only data plane), `allowBlobPublicAccess=false`, TLS 1.2 minimum, blob + container soft delete 30 days. MI has `Storage Blob Data Contributor`. |
| **Foundry account** | `disableLocalAuth=true` — no API keys, Entra tokens only. MI has `Azure AI User`. |
| **Container** | Runs as a non-root `scout` user, slim base image, health-checked on `/healthz`. |
| **Diagnostics** | Foundry audit + operational logs streamed to Log Analytics. |
| **Network** | All endpoints are TLS. Public network is on by default for simplicity — switch to Private Endpoints by setting `publicNetworkAccess=Disabled` on the resources in `main.bicep` when needed. |

Rotating secrets requires only a KV update — no redeploy:

```bash
az keyvault secret set --vault-name $KV_NAME --name youtube-api-key --value '<new-key>'
```


## Local Development

```bash
cd hosted
python -m venv .venv
.venv/Scripts/activate     # Windows
# source .venv/bin/activate  # macOS/Linux
pip install -r requirements.txt
cp .env.example .env
# Edit .env with your values
python app.py
```

The agent starts on `http://localhost:8088`. Send test requests:

```bash
curl -X POST http://localhost:8088/responses \
  -H "Content-Type: application/json" \
  -d '{"input": "scout scan"}'
```

## Implementation Status

The hosted agent scaffolding is in place. Current status:

| Module | Status | Notes |
|--------|--------|-------|
| Config parser | Working | Reads `scout-config-*.prompt.md` files |
| Dev.to scanner | Working | REST API |
| Medium scanner | Working | RSS feed |
| GitHub scanner | Working | Search API with fork/exclusion filtering |
| YouTube scanner | Working | Data API v3 |
| Stack Overflow | Working | Public API v2.3 |
| Reddit | Working | OAuth2 app-only auth (free) |
| Hacker News | Working | Algolia API |
| Quality filter | Working | Date gate, relevancy gate, scoring |
| Dedup tracker | Working | `.seen-links.json` |
| Report generator | Working | Basic markdown output |
| Hashnode scanner | Stub | Needs GraphQL implementation |
| Bluesky scanner | Stub | Needs AT Protocol authentication |
| X/Twitter scanner | Stub | Needs bearer token search |
| Social post generator | Stub | Needs LLM integration for varied framing |
| Trends analysis | Stub | Needs report parsing |
| Gap analysis | Stub | Needs tag extraction from reports |

Contributions welcome — see [CONTRIBUTING.md](../CONTRIBUTING.md).
